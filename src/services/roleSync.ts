import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Logger } from '../logger.js';
import type { Repo, UserRow } from '../db/repo.js';
import type { LogtoManagement } from '../logto/management.js';
import type { RoleConfigStore } from './roleConfigStore.js';
import { eventBus } from '../net/events.js';

export type RoleSyncGroup = {
  chatId: number;
  mapping: Record<string, string[]>;
  customTitleMap: Record<string, string>;
  removeOnLeave: boolean;
};

export type RoleSyncConfig = {
  enabled: boolean;
  groups: RoleSyncGroup[];
};

export type ChatMemberLike = {
  status: string;
  custom_title?: string;
};

export type TelegramMemberApi = {
  getChatMember(chatId: number, userId: number): Promise<ChatMemberLike>;
  getChatAdministrators(chatId: number): Promise<{ user: { id: number }; status: string; custom_title?: string }[]>;
};

export type SyncResult = {
  tgUserId: number;
  status: string;
  before: string[];
  after: string[];
  added: string[];
  removed: string[];
};

export type SyncReport = {
  checked: number;
  changed: SyncResult[];
  failed: { tgUserId: number; error: string }[];
};

export const EMPTY_ROLE_CONFIG: RoleSyncConfig = { enabled: false, groups: [] };

/** Only used to seed a fresh database / import legacy config files. */
export const loadRoleConfig = (path: string, logger: Logger): RoleSyncConfig => {
  try {
    const parsed = JSON.parse(readFileSync(resolve(path), 'utf8')) as Partial<RoleSyncConfig>;
    return {
      enabled: parsed.enabled ?? false,
      groups: (parsed.groups ?? []).map((group) => ({
        chatId: Number(group.chatId),
        mapping: group.mapping ?? {},
        customTitleMap: group.customTitleMap ?? {},
        removeOnLeave: group.removeOnLeave ?? true,
      })),
    };
  } catch (error) {
    logger.warn({ path, error: (error as Error).message }, 'roles config not loaded');
    return EMPTY_ROLE_CONFIG;
  }
};

/** Pure mapping: chat member state -> desired Logto role ids. */
export const desiredRoles = (
  group: RoleSyncGroup,
  member: ChatMemberLike,
): { roles: string[]; leaving: boolean } => {
  const leaving = ['left', 'kicked'].includes(member.status);
  if (leaving) {
    return { roles: [], leaving: true };
  }

  const roles = new Set<string>(group.mapping[member.status] ?? []);
  const title = member.custom_title?.trim();
  if (title && group.customTitleMap[title]) {
    roles.add(group.customTitleMap[title]);
  }

  return { roles: [...roles], leaving: false };
};

const sleep = (ms: number): Promise<void> => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

export class RoleSyncService {
  private locks = new Set<number>();

  constructor(
    private readonly deps: {
      store: RoleConfigStore;
      repo: Repo;
      management: LogtoManagement;
      api: TelegramMemberApi;
      logger: Logger;
      requestDelayMs?: number;
    },
  ) {}

  get available(): boolean {
    const config = this.deps.store.getConfig();
    return config.enabled && config.groups.length > 0;
  }

  getConfig(): RoleSyncConfig {
    return this.deps.store.getConfig();
  }

  findGroup(chatId: number): RoleSyncGroup | undefined {
    return this.deps.store.getConfig().groups.find((group) => group.chatId === chatId);
  }

  async syncMember(input: {
    chatId: number;
    tgUserId: number;
    reason: string;
    member?: ChatMemberLike;
  }): Promise<SyncResult | undefined> {
    const { repo, management, api, logger } = this.deps;
    const group = this.findGroup(input.chatId);
    if (!group) {
      return undefined;
    }

    const user: UserRow | undefined = repo.findByTgId(input.tgUserId);
    if (!user?.logto_user_id) {
      logger.debug({ tgUserId: input.tgUserId, chatId: input.chatId }, 'role sync skipped: user not bound');
      return undefined;
    }

    const member = input.member ?? (await api.getChatMember(input.chatId, input.tgUserId));
    const { roles: desired } = desiredRoles(group, member);

    const current = await management.getUserRoles(user.logto_user_id);
    const before = current.map((role) => role.id);
    const added = desired.filter((roleId) => !before.includes(roleId));
    const removed = before.filter(
      (roleId) => !desired.includes(roleId) && this.managesRole(group, roleId),
    );

    if (added.length > 0) {
      await management.assignRoles(user.logto_user_id, added);
    }
    for (const roleId of removed) {
      await management.removeRole(user.logto_user_id, roleId);
    }

    const after = [...before.filter((roleId) => !removed.includes(roleId)), ...added];
    repo.logRoleSync({
      chatId: input.chatId,
      tgUserId: input.tgUserId,
      logtoUserId: user.logto_user_id,
      before,
      after,
      reason: input.reason,
    });

    if (added.length > 0 || removed.length > 0) {
      eventBus.emit('role_sync', {
        chatId: input.chatId,
        tgUserId: input.tgUserId,
        added,
        removed,
        reason: input.reason,
      });
    }

    logger.info(
      { tgUserId: input.tgUserId, chatId: input.chatId, added, removed, reason: input.reason },
      'role sync applied',
    );

    return { tgUserId: input.tgUserId, status: member.status, before, after, added, removed };
  }

  /** Only roles that appear in this group's mapping are ever removed. */
  private managesRole(group: RoleSyncGroup, roleId: string): boolean {
    const managed = new Set([
      ...Object.values(group.mapping).flat(),
      ...Object.values(group.customTitleMap),
    ]);
    return managed.has(roleId);
  }

  async syncChatAdmins(chatId: number, reason: string): Promise<SyncResult[]> {
    const admins = await this.deps.api.getChatAdministrators(chatId);
    const results: SyncResult[] = [];
    for (const admin of admins) {
      const result = await this.syncMember({
        chatId,
        tgUserId: admin.user.id,
        reason,
        member: { status: admin.status, custom_title: admin.custom_title },
      }).catch((error: Error) => {
        this.deps.logger.warn({ tgUserId: admin.user.id, error: error.message }, 'role sync failed for admin');
        return undefined;
      });
      if (result) {
        results.push(result);
      }
    }
    return results;
  }

  /**
   * Full pass for one chat: administrators from the Bot API plus every bound
   * user we know about (the Bot API cannot enumerate all members).
   * Guarded by an in-process lock so a second `/sync` is a no-op while running.
   */
  async syncChat(input: { chatId: number; reason: string; maxUsers?: number }): Promise<SyncReport | 'busy'> {
    if (this.locks.has(input.chatId)) {
      return 'busy';
    }
    this.locks.add(input.chatId);

    const report: SyncReport = { checked: 0, changed: [], failed: [] };
    const delay = this.deps.requestDelayMs ?? 30;

    try {
      const admins = await this.deps.api.getChatAdministrators(input.chatId);
      const seen = new Set<number>();

      for (const admin of admins) {
        seen.add(admin.user.id);
        report.checked += 1;
        const result = await this.syncMember({
          chatId: input.chatId,
          tgUserId: admin.user.id,
          reason: input.reason,
          member: { status: admin.status, custom_title: admin.custom_title },
        }).catch((error: Error) => {
          report.failed.push({ tgUserId: admin.user.id, error: error.message });
          return undefined;
        });
        if (result && (result.added.length > 0 || result.removed.length > 0)) {
          report.changed.push(result);
        }
      }

      const users = this.deps.repo.listUsers(input.maxUsers ?? 500);
      for (const user of users) {
        if (seen.has(user.tg_user_id)) {
          continue;
        }
        report.checked += 1;
        try {
          const member = await this.deps.api.getChatMember(input.chatId, user.tg_user_id);
          const result = await this.syncMember({
            chatId: input.chatId,
            tgUserId: user.tg_user_id,
            reason: input.reason,
            member,
          });
          if (result && (result.added.length > 0 || result.removed.length > 0)) {
            report.changed.push(result);
          }
        } catch (error) {
          // "user not found" / "user not participant" is expected for most users.
          report.failed.push({ tgUserId: user.tg_user_id, error: (error as Error).message });
        }
        if (delay > 0) {
          await sleep(delay);
        }
      }

      this.deps.logger.info(
        { chatId: input.chatId, checked: report.checked, changed: report.changed.length },
        'role sync sweep finished',
      );

      return report;
    } finally {
      this.locks.delete(input.chatId);
    }
  }
}
