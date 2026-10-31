import type { Bot } from 'grammy';

import type { AppConfig } from '../config.js';
import type { Repo } from '../db/repo.js';
import type { Logger } from '../logger.js';
import { eventBus } from '../net/events.js';

export type SendOptions = {
  disablePreview?: boolean;
  replyMarkup?: Record<string, unknown>;
};

type BotErrorLike = {
  error_code?: number;
  parameters?: { retry_after?: number };
  description?: string;
  message?: string;
};

const asBotError = (error: unknown): BotErrorLike =>
  error && typeof error === 'object' ? (error as BotErrorLike) : { message: String(error) };

/**
 * Durable outbox: every outgoing message is persisted first, then delivered by a
 * single worker with a global rate limit (Telegram: ~30 msg/s), a per-chat limit
 * (1 msg/s) and retry handling for 429/5xx.
 */
export class Outbox {
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private lastGlobalAt = 0;
  private readonly lastPerChat = new Map<number, number>();

  constructor(
    private readonly deps: {
      repo: Repo;
      bot: Bot;
      config: AppConfig;
      logger: Logger;
    },
  ) {}

  enqueue(chatId: number, text: string, options: SendOptions = {}): void {
    const payload: Record<string, unknown> = {
      text,
      parse_mode: 'MarkdownV2',
      link_preview_options: { is_disabled: options.disablePreview ?? true },
    };
    if (options.replyMarkup) {
      payload.reply_markup = options.replyMarkup;
    }
    this.deps.repo.enqueue(chatId, payload);
  }

  start(intervalMs = 800): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async tick(): Promise<void> {
    if (this.ticking) {
      return;
    }
    this.ticking = true;

    try {
      const rows = this.deps.repo.claimDue(25);
      for (const row of rows) {
        const now = Date.now();
        const lastChat = this.lastPerChat.get(row.chat_id) ?? 0;

        if (now - this.lastGlobalAt < 34) {
          break; // global pace
        }
        if (now - lastChat < 1000) {
          continue; // per-chat pace
        }

        this.lastGlobalAt = now;
        this.lastPerChat.set(row.chat_id, now);
        await this.deliver(row);
      }
    } catch (error) {
      this.deps.logger.error({ error: (error as Error).message }, 'outbox tick failed');
    } finally {
      this.ticking = false;
    }
  }

  private async deliver(row: {
    id: number;
    chat_id: number;
    payload: string;
    attempts: number;
  }): Promise<void> {
    const { repo, bot, config, logger } = this.deps;
    const payload = JSON.parse(row.payload) as Record<string, unknown>;

    if (config.runtime.dryRun) {
      logger.info({ chatId: row.chat_id, payload }, 'dry-run: message not sent');
      repo.markOutboxSent(row.id);
      return;
    }

    try {
      await bot.api.sendMessage(row.chat_id, String(payload.text ?? ''), {
        parse_mode: 'MarkdownV2',
        link_preview_options: { is_disabled: true },
        ...(payload.reply_markup ? { reply_markup: payload.reply_markup as never } : {}),
      });
      repo.markOutboxSent(row.id);
      eventBus.emit('outbox', { status: 'sent', chatId: row.chat_id });
    } catch (error) {
      const detail = asBotError(error);
      const code = detail.error_code ?? 0;
      const attempts = row.attempts + 1;

      if (code === 403) {
        // User blocked the bot or never granted telegram:bot_access.
        repo.markNotifyBlocked(row.chat_id, true);
        repo.markOutboxFailed(row.id, attempts, 0, detail.description ?? 'forbidden', true);
        eventBus.emit('outbox', { status: 'blocked', chatId: row.chat_id });
        logger.warn({ chatId: row.chat_id }, 'telegram rejected message (403), notifications disabled for user');
        return;
      }

      if (code === 429) {
        const retry = (detail.parameters?.retry_after ?? 3) * 1000;
        repo.markOutboxFailed(row.id, attempts, Math.floor((Date.now() + retry) / 1000), 'rate limited');
        return;
      }

      const dead = attempts >= 5;
      const backoff = Math.min(2 ** attempts, 300);
      repo.markOutboxFailed(
        row.id,
        attempts,
        Math.floor(Date.now() / 1000) + backoff,
        detail.description ?? detail.message ?? 'unknown error',
        dead,
      );
      eventBus.emit('outbox', { status: dead ? 'dead' : 'retry', chatId: row.chat_id, code, attempts });
      logger.warn({ chatId: row.chat_id, attempts, code }, 'message delivery failed');
    }
  }
}
