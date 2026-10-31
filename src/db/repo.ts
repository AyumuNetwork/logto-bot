import { nowSeconds, type Database } from './index.js';

export type UserRow = {
  id: number;
  tg_user_id: number;
  tg_username: string | null;
  logto_user_id: string | null;
  logto_email: string | null;
  notify_flags: string;
  bind_source: string;
  notify_blocked: number;
  status: string;
  bound_at: number;
  updated_at: number;
};

export type LoginLinkRow = {
  id: number;
  tg_user_id: number;
  logto_user_id: string | null;
  email: string | null;
  ott_id: string | null;
  strategy: string;
  url: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  context_json?: string | null;
};

export type RoleGroupRow = {
  chat_id: number;
  enabled: number;
  remove_on_leave: number;
  title: string | null;
  created_at: number;
  created_by: number | null;
};

export type RoleMappingRow = {
  id: number;
  chat_id: number;
  kind: 'status' | 'title';
  key: string;
  role_id: string;
  created_at: number;
  created_by: number | null;
};

export type AuditRow = {
  id: number;
  actor_tg_id: number;
  action: string;
  target: string | null;
  detail: string | null;
  at: number;
};

export type OutboxRow = {
  id: number;
  chat_id: number;
  method: string;
  payload: string;
  attempts: number;
  next_at: number;
  status: string;
  last_error: string | null;
  created_at: number;
};

export type NotifyFlags = Record<string, boolean>;

export class Repo {
  constructor(private readonly db: Database) {}

  // ---------------------------------------------------------------- users ---

  findByTgId(tgUserId: number): UserRow | undefined {
    return this.db
      .prepare('SELECT * FROM users WHERE tg_user_id = ?')
      .get(tgUserId) as UserRow | undefined;
  }

  findByLogtoId(logtoUserId: string): UserRow | undefined {
    return this.db
      .prepare('SELECT * FROM users WHERE logto_user_id = ?')
      .get(logtoUserId) as UserRow | undefined;
  }

  findByEmail(email: string): UserRow | undefined {
    return this.db
      .prepare('SELECT * FROM users WHERE lower(logto_email) = lower(?)')
      .get(email) as UserRow | undefined;
  }

  /**
   * Bind (or refresh) a Telegram chat <-> Logto user pair.
   * Returns `created: true` only when the binding did not exist before, so the
   * caller can decide whether to send a welcome message.
   */
  upsertBinding(input: {
    tgUserId: number;
    tgUsername?: string | null;
    logtoUserId: string;
    email?: string | null;
    source: 'auto' | 'link' | 'code' | 'manual';
    defaultFlags: NotifyFlags;
  }): { row: UserRow; created: boolean } {
    const now = nowSeconds();
    const existing = this.findByTgId(input.tgUserId) ?? this.findByLogtoId(input.logtoUserId);

    if (existing) {
      this.db
        .prepare(
          `UPDATE users
              SET tg_user_id = ?, tg_username = COALESCE(?, tg_username),
                  logto_user_id = ?, logto_email = COALESCE(?, logto_email),
                  status = 'active', notify_blocked = 0, updated_at = ?
            WHERE id = ?`,
        )
        .run(
          input.tgUserId,
          input.tgUsername ?? null,
          input.logtoUserId,
          input.email ?? null,
          now,
          existing.id,
        );
      const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(existing.id) as UserRow;
      return { row, created: false };
    }

    this.db
      .prepare(
        `INSERT INTO users (tg_user_id, tg_username, logto_user_id, logto_email, notify_flags,
                            bind_source, bound_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.tgUserId,
        input.tgUsername ?? null,
        input.logtoUserId,
        input.email ?? null,
        JSON.stringify(input.defaultFlags),
        input.source,
        now,
        now,
      );

    const row = this.findByTgId(input.tgUserId)!;
    return { row, created: true };
  }

  unbind(tgUserId: number): boolean {
    const result = this.db.prepare('DELETE FROM users WHERE tg_user_id = ?').run(tgUserId);
    return Number(result.changes) > 0;
  }

  listUsers(limit = 500, offset = 0): UserRow[] {
    return this.db
      .prepare('SELECT * FROM users ORDER BY bound_at DESC LIMIT ? OFFSET ?')
      .all(limit, offset) as UserRow[];
  }

  countUsers(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number };
    return Number(row.count);
  }

  parseFlags(row: UserRow): NotifyFlags {
    try {
      const parsed = JSON.parse(row.notify_flags) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as NotifyFlags) : {};
    } catch {
      return {};
    }
  }

  setFlags(tgUserId: number, flags: NotifyFlags): void {
    this.db
      .prepare('UPDATE users SET notify_flags = ?, updated_at = ? WHERE tg_user_id = ?')
      .run(JSON.stringify(flags), nowSeconds(), tgUserId);
  }

  markNotifyBlocked(tgUserId: number, blocked: boolean): void {
    this.db
      .prepare('UPDATE users SET notify_blocked = ?, updated_at = ? WHERE tg_user_id = ?')
      .run(blocked ? 1 : 0, nowSeconds(), tgUserId);
  }

  // ----------------------------------------------------------- login links ---

  insertLoginLink(input: {
    tgUserId: number;
    logtoUserId?: string | null;
    email?: string | null;
    ottId?: string | null;
    strategy: string;
    url: string;
    expiresAt: number;
    contextJson?: string | null;
  }): LoginLinkRow {
    const result = this.db
      .prepare(
        `INSERT INTO login_links (tg_user_id, logto_user_id, email, ott_id, strategy, url, created_at, expires_at, context_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.tgUserId,
        input.logtoUserId ?? null,
        input.email ?? null,
        input.ottId ?? null,
        input.strategy,
        input.url,
        nowSeconds(),
        input.expiresAt,
        input.contextJson ?? null,
      );
    return this.db
      .prepare('SELECT * FROM login_links WHERE id = ?')
      .get(Number(result.lastInsertRowid)) as LoginLinkRow;
  }

  listLoginLinks(tgUserId: number, limit = 8): LoginLinkRow[] {
    return this.db
      .prepare('SELECT * FROM login_links WHERE tg_user_id = ? ORDER BY id DESC LIMIT ?')
      .all(tgUserId, limit) as LoginLinkRow[];
  }

  findLoginLink(id: number, tgUserId: number): LoginLinkRow | undefined {
    return this.db
      .prepare('SELECT * FROM login_links WHERE id = ? AND tg_user_id = ?')
      .get(id, tgUserId) as LoginLinkRow | undefined;
  }

  revokeLoginLink(id: number, tgUserId: number): boolean {
    const result = this.db
      .prepare('UPDATE login_links SET revoked_at = ? WHERE id = ? AND tg_user_id = ? AND revoked_at IS NULL')
      .run(nowSeconds(), id, tgUserId);
    return Number(result.changes) > 0;
  }

  // ------------------------------------------------------------ bind codes ---

  insertBindCode(codeHash: string, tgUserId: number, ttlSeconds: number): void {
    const now = nowSeconds();
    this.db
      .prepare('INSERT INTO bind_codes (code_hash, tg_user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(codeHash, tgUserId, now, now + ttlSeconds);
  }

  consumeBindCode(codeHash: string, tgUserId: number): boolean {
    const now = nowSeconds();
    const result = this.db
      .prepare(
        `UPDATE bind_codes SET used_at = ?
          WHERE code_hash = ? AND tg_user_id = ? AND used_at IS NULL AND expires_at > ?`,
      )
      .run(now, codeHash, tgUserId, now);
    return Number(result.changes) > 0;
  }

  // -------------------------------------------------------------- webhook ---

  /** Insert the delivery; returns false when this exact body was already handled. */
  recordEvent(input: {
    dedupeKey: string;
    hookId?: string | null;
    event: string;
    createdAtLogto?: string | null;
    status: string;
    payload: string;
  }): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO logto_events (dedupe_key, hook_id, event, created_at_logto, received_at, status, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.dedupeKey,
        input.hookId ?? null,
        input.event,
        input.createdAtLogto ?? null,
        nowSeconds(),
        input.status,
        input.payload,
      );
    return Number(result.changes) > 0;
  }

  updateEventStatus(dedupeKey: string, status: string): void {
    this.db.prepare('UPDATE logto_events SET status = ? WHERE dedupe_key = ?').run(status, dedupeKey);
  }

  // --------------------------------------------------------------- outbox ---

  enqueue(chatId: number, payload: Record<string, unknown>, method = 'sendMessage'): void {
    const now = nowSeconds();
    this.db
      .prepare(
        'INSERT INTO outbox (chat_id, method, payload, next_at, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(chatId, method, JSON.stringify(payload), now, now);
  }

  claimDue(limit = 20): OutboxRow[] {
    const now = nowSeconds();
    return this.db
      .prepare(`SELECT * FROM outbox WHERE status = 'pending' AND next_at <= ? ORDER BY id LIMIT ?`)
      .all(now, limit) as OutboxRow[];
  }

  markOutboxSent(id: number): void {
    this.db.prepare(`UPDATE outbox SET status = 'sent' WHERE id = ?`).run(id);
  }

  markOutboxFailed(id: number, attempts: number, nextAt: number, error: string, dead = false): void {
    this.db
      .prepare('UPDATE outbox SET attempts = ?, next_at = ?, last_error = ?, status = ? WHERE id = ?')
      .run(attempts, nextAt, error.slice(0, 500), dead ? 'dead' : 'pending', id);
  }

  // -------------------------------------------------------------- misc ------

  logRoleSync(entry: {
    chatId: number;
    tgUserId: number;
    logtoUserId?: string | null;
    before: string[];
    after: string[];
    reason: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO role_sync_log (chat_id, tg_user_id, logto_user_id, before_roles, after_roles, reason, at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.chatId,
        entry.tgUserId,
        entry.logtoUserId ?? null,
        JSON.stringify(entry.before),
        JSON.stringify(entry.after),
        entry.reason,
        nowSeconds(),
      );
  }

  getSetting(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }
  // ------------------------------------------------------- role groups -----

  listRoleGroups(): RoleGroupRow[] {
    return this.db.prepare('SELECT * FROM role_groups ORDER BY created_at ASC').all() as RoleGroupRow[];
  }

  getRoleGroup(chatId: number): RoleGroupRow | undefined {
    return this.db.prepare('SELECT * FROM role_groups WHERE chat_id = ?').get(chatId) as
      | RoleGroupRow
      | undefined;
  }

  upsertRoleGroup(input: {
    chatId: number;
    enabled?: boolean;
    removeOnLeave?: boolean;
    title?: string | null;
    actor?: number | null;
  }): void {
    const now = nowSeconds();
    const existing = this.getRoleGroup(input.chatId);

    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO role_groups (chat_id, enabled, remove_on_leave, title, created_at, created_by)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.chatId,
          input.enabled === false ? 0 : 1,
          input.removeOnLeave === false ? 0 : 1,
          input.title ?? null,
          now,
          input.actor ?? null,
        );
      return;
    }

    this.db
      .prepare(
        `UPDATE role_groups SET enabled = ?, remove_on_leave = ?, title = COALESCE(?, title) WHERE chat_id = ?`,
      )
      .run(
        (input.enabled ?? existing.enabled === 1) ? 1 : 0,
        (input.removeOnLeave ?? existing.remove_on_leave === 1) ? 1 : 0,
        input.title ?? null,
        input.chatId,
      );
  }

  deleteRoleGroup(chatId: number): boolean {
    const result = this.db.prepare('DELETE FROM role_groups WHERE chat_id = ?').run(chatId);
    this.db.prepare('DELETE FROM role_mappings WHERE chat_id = ?').run(chatId);
    return Number(result.changes) > 0;
  }

  // ---------------------------------------------------------- mappings -----

  listRoleMappings(chatId?: number): RoleMappingRow[] {
    return chatId === undefined
      ? (this.db.prepare('SELECT * FROM role_mappings ORDER BY chat_id, kind, key').all() as RoleMappingRow[])
      : (this.db
          .prepare('SELECT * FROM role_mappings WHERE chat_id = ? ORDER BY kind, key')
          .all(chatId) as RoleMappingRow[]);
  }

  upsertRoleMapping(input: {
    chatId: number;
    kind: 'status' | 'title';
    key: string;
    roleId: string;
    actor?: number | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO role_mappings (chat_id, kind, key, role_id, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(chat_id, kind, key) DO UPDATE SET role_id = excluded.role_id`,
      )
      .run(input.chatId, input.kind, input.key, input.roleId, nowSeconds(), input.actor ?? null);
  }

  deleteRoleMapping(chatId: number, kind: 'status' | 'title', key: string): boolean {
    const result = this.db
      .prepare('DELETE FROM role_mappings WHERE chat_id = ? AND kind = ? AND key = ?')
      .run(chatId, kind, key);
    return Number(result.changes) > 0;
  }

  // ------------------------------------------------------------- audit -----

  insertAudit(actorTgId: number, action: string, target?: string | null, detail?: unknown): void {
    this.db
      .prepare('INSERT INTO admin_audit (actor_tg_id, action, target, detail, at) VALUES (?, ?, ?, ?, ?)')
      .run(
        actorTgId,
        action,
        target ?? null,
        detail === undefined ? null : JSON.stringify(detail),
        nowSeconds(),
      );
  }

  listAudit(limit = 20): AuditRow[] {
    return this.db.prepare('SELECT * FROM admin_audit ORDER BY id DESC LIMIT ?').all(limit) as AuditRow[];
  }

  // ------------------------------------------------------------ queries ----

  /** Look a bound user up by telegram id, @username, email or Logto user id. */
  searchUser(key: string): UserRow[] {
    const trimmed = key.trim();
    if (/^-?\d+$/.test(trimmed)) {
      const byTg = this.findByTgId(Number(trimmed));
      if (byTg) return [byTg];
    }

    if (/^[A-Za-z0-9]{8,}$/.test(trimmed)) {
      const byLogto = this.db.prepare('SELECT * FROM users WHERE logto_user_id = ?').get(trimmed) as
        | UserRow
        | undefined;
      if (byLogto) return [byLogto];
    }

    const username = trimmed.replace(/^@/, '');
    const byUsername = this.db
      .prepare('SELECT * FROM users WHERE lower(tg_username) = lower(?)')
      .all(username) as UserRow[];
    if (byUsername.length > 0) return byUsername;

    const byEmail = this.db
      .prepare('SELECT * FROM users WHERE lower(logto_email) = lower(?)')
      .all(trimmed) as UserRow[];
    return byEmail;
  }

  listSignupLinks(limit = 10): LoginLinkRow[] {
    return this.db
      .prepare("SELECT * FROM login_links WHERE strategy = 'ott_register' ORDER BY id DESC LIMIT ?")
      .all(limit) as LoginLinkRow[];
  }

  findLoginLinkByOttId(ottId: string): LoginLinkRow | undefined {
    return this.db.prepare('SELECT * FROM login_links WHERE ott_id = ?').get(ottId) as
      | LoginLinkRow
      | undefined;
  }

  // ------------------------------------------------------------ stats ------

  countEventsSince(since: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM logto_events WHERE received_at >= ?')
      .get(since) as { count: number };
    return Number(row.count);
  }

  eventBreakdownSince(since: number, limit = 8): { event: string; count: number }[] {
    return this.db
      .prepare(
        'SELECT event, COUNT(*) AS count FROM logto_events WHERE received_at >= ? GROUP BY event ORDER BY count DESC LIMIT ?',
      )
      .all(since, limit) as { event: string; count: number }[];
  }

  recentEvents(limit = 10): { event: string; received_at: number; status: string; dedupe_key: string }[] {
    return this.db
      .prepare(
        'SELECT event, received_at, status, dedupe_key FROM logto_events ORDER BY received_at DESC, rowid DESC LIMIT ?',
      )
      .all(limit) as { event: string; received_at: number; status: string; dedupe_key: string }[];
  }

  outboxStats(): { pending: number; dead: number; sent: number; oldestPendingAt: number | null } {
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS count FROM outbox GROUP BY status')
      .all() as { status: string; count: number }[];
    const byStatus = new Map(rows.map((row) => [row.status, Number(row.count)]));
    const oldest = this.db
      .prepare("SELECT MIN(created_at) AS at FROM outbox WHERE status = 'pending'")
      .get() as { at: number | null };
    return {
      pending: byStatus.get('pending') ?? 0,
      dead: byStatus.get('dead') ?? 0,
      sent: byStatus.get('sent') ?? 0,
      oldestPendingAt: oldest.at ?? null,
    };
  }

  retryDeadOutbox(): number {
    const result = this.db
      .prepare("UPDATE outbox SET status = 'pending', attempts = 0, next_at = ? WHERE status = 'dead'")
      .run(nowSeconds());
    return Number(result.changes);
  }

  purgeSentOutbox(): number {
    const result = this.db.prepare("DELETE FROM outbox WHERE status = 'sent'").run();
    return Number(result.changes);
  }
}
