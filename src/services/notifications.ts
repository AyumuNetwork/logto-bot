import type { UserRow } from '../db/repo.js';
import type { NotificationKind } from '../config.js';
import { escapeMarkdown } from '../telegram/esc.js';

export type LogtoWebhookPayload = {
  hookId?: string;
  event: string;
  createdAt?: string;
  userAgent?: string;
  ip?: string;
  userIp?: string;
  interactionEvent?: 'SignIn' | 'Register' | 'ForgotPassword';
  sessionId?: string;
  userId?: string;
  user?: {
    id: string;
    username?: string | null;
    primaryEmail?: string | null;
    primaryPhone?: string | null;
    name?: string | null;
    isSuspended?: boolean;
    identities?: Record<string, { userId: string; details?: Record<string, unknown> | null }>;
  };
  applicationId?: string;
  application?: { id: string; name: string; type: string };
  data?: unknown;
  organizationId?: string;
  addedUserIds?: string[];
  removedUserIds?: string[];
  method?: string;
  path?: string;
};

export type NotificationPlan = {
  kind: NotificationKind | 'none';
  title: string;
  lines: string[];
  emoji: string;
};

const formatTime = (iso?: string): string => {
  const date = iso ? new Date(iso) : new Date();
  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString();
  }
  // Render in China Standard Time; the audience is zh-CN.
  return date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
};

const describeUserDataChanges = (data: unknown): string[] => {
  if (!data || typeof data !== 'object') {
    return [];
  }
  const record = data as Record<string, unknown>;
  const lines: string[] = [];
  if (typeof record.primaryEmail === 'string') lines.push(`邮箱：${record.primaryEmail}`);
  if (typeof record.primaryPhone === 'string') lines.push(`手机号：${record.primaryPhone}`);
  if (typeof record.name === 'string') lines.push(`名称：${record.name}`);
  if (typeof record.username === 'string') lines.push(`用户名：${record.username}`);
  if (record.identities && typeof record.identities === 'object') {
    lines.push(`社交身份：${Object.keys(record.identities as object).join(', ') || '无'}`);
  }
  if (record.isSuspended !== undefined) lines.push(`状态：${record.isSuspended ? '已封禁' : '正常'}`);
  return lines;
};

/**
 * Translate a Logto webhook delivery into a user-facing notification plan.
 * `kind: 'none'` means "record it, do not message anyone".
 */
export const planNotification = (payload: LogtoWebhookPayload): NotificationPlan => {
  const app = payload.application?.name;
  const ip = payload.ip ?? payload.userIp;
  const when = formatTime(payload.createdAt);
  const device = payload.userAgent;

  const base = [
    app ? `应用：${app}` : undefined,
    ip ? `IP：${ip}` : undefined,
    device ? `设备：${device}` : undefined,
    `时间：${when}`,
  ].filter((line): line is string => Boolean(line));

  switch (payload.event) {
    case 'PostSignIn':
      return { kind: 'signin', emoji: '🔐', title: '新的登录', lines: base };

    case 'PostRegister':
      return {
        kind: 'account',
        emoji: '🎉',
        title: '账号注册成功',
        lines: [...base, '提示：在 Bot 里发送 /login 可获取一次性登录链接。'],
      };

    case 'PostResetPassword':
      return {
        kind: 'password',
        emoji: '🔑',
        title: '密码已被重置',
        lines: [...base, '如非本人操作，请立刻修改密码并检查登录会话。'],
      };

    case 'User.Data.Updated':
      return {
        kind: 'account',
        emoji: '📝',
        title: '账号资料变更',
        lines: [...describeUserDataChanges(payload.data), ...base],
      };

    case 'User.SuspensionStatus.Updated': {
      const suspended = (payload.data as Record<string, unknown> | undefined)?.isSuspended === true;
      return {
        kind: 'security',
        emoji: suspended ? '⛔' : '✅',
        title: suspended ? '账号已被封禁' : '账号已解除封禁',
        lines: base,
      };
    }

    case 'User.Deleted':
      return {
        kind: 'security',
        emoji: '🗑',
        title: '账号已被删除',
        lines: [...base, 'Telegram 绑定已自动解除。'],
      };

    case 'Identifier.Lockout':
      return {
        kind: 'security',
        emoji: '🚨',
        title: '账号因连续验证失败被锁定',
        lines: [...base, '建议立刻检查账号安全设置。'],
      };

    case 'TrustedDevice.Created':
      return { kind: 'security', emoji: '💻', title: '新增受信任设备', lines: base };

    case 'TrustedDevice.Deleted':
      return { kind: 'security', emoji: '🧹', title: '移除了受信任设备', lines: base };

    case 'Organization.Membership.Updated': {
      const added = payload.addedUserIds?.length ?? 0;
      const removed = payload.removedUserIds?.length ?? 0;
      return {
        kind: 'account',
        emoji: '🏢',
        title: '组织成员变更',
        lines: [`组织：${payload.organizationId ?? '未知'}`, `新增 ${added} 人，移除 ${removed} 人`, ...base],
      };
    }

    case 'Message.RateLimited':
    case 'Grant.LimitExceeded':
      return { kind: 'none', emoji: 'ℹ️', title: payload.event, lines: base };

    default:
      return { kind: 'none', emoji: 'ℹ️', title: payload.event, lines: base };
  }
};

export const renderNotification = (plan: NotificationPlan, user?: UserRow): string => {
  const header = `${plan.emoji} *${escapeMarkdown(plan.title)}*`;
  const lines = plan.lines.map((line) => `• ${escapeMarkdown(line)}`);
  const footer = user ? `\n_绑定账号：${escapeMarkdown(user.logto_email ?? user.logto_user_id ?? '未知')}_` : '';
  return [header, ...lines].join('\n') + footer;
};

export const renderWelcome = (user: UserRow): string =>
  [
    '✅ *已绑定成功*',
    `• Logto 账号：${escapeMarkdown(user.logto_email ?? user.logto_user_id ?? '未知')}`,
    '• 之后这里会收到登录、改密、安全告警等通知',
    '',
    '常用命令：`/login` 一次性登录链接 · `/whoami` 查看绑定 · `/settings` 通知开关 · `/unbind` 解绑',
  ].join('\n');
