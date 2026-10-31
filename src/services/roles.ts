import type { Logger } from '../logger.js';
import type { LogtoManagement, LogtoRole } from '../logto/management.js';

export type RoleResolution =
  | { ok: true; role: LogtoRole }
  | { ok: false; reason: 'not-found' | 'ambiguous' | 'unavailable'; candidates: LogtoRole[] };

const CACHE_TTL_MS = 5 * 60_000;

/**
 * Resolve human input ("Admins", "admin", "vy42rcdc6akw…") to a Logto role.
 * Order: exact id -> exact name (case sensitive) -> exact name (case
 * insensitive) -> unique substring. Ambiguity is reported, never guessed.
 */
export class RoleResolver {
  private cache?: { at: number; roles: LogtoRole[] };

  constructor(
    private readonly deps: {
      management: LogtoManagement;
      logger: Logger;
      ttlMs?: number;
    },
  ) {}

  async list(force = false): Promise<LogtoRole[]> {
    const now = Date.now();
    const ttl = this.deps.ttlMs ?? CACHE_TTL_MS;
    if (!force && this.cache && now - this.cache.at < ttl) {
      return this.cache.roles;
    }

    const roles = await this.deps.management.listRoles();
    this.cache = { at: now, roles };
    return roles;
  }

  invalidate(): void {
    this.cache = undefined;
  }

  async resolve(input: string): Promise<RoleResolution> {
    const query = input.trim();
    if (!query) {
      return { ok: false, reason: 'not-found', candidates: [] };
    }

    let roles: LogtoRole[];
    try {
      roles = await this.list();
    } catch (error) {
      this.deps.logger.warn({ error: (error as Error).message }, 'cannot list logto roles');
      return { ok: false, reason: 'unavailable', candidates: [] };
    }

    const exactId = roles.find((role) => role.id === query);
    if (exactId) {
      return { ok: true, role: exactId };
    }

    const exactName = roles.find((role) => role.name === query);
    if (exactName) {
      return { ok: true, role: exactName };
    }

    const lower = query.toLowerCase();
    const insensitive = roles.filter((role) => role.name.toLowerCase() === lower);
    if (insensitive.length === 1) {
      return { ok: true, role: insensitive[0]! };
    }

    const partial = roles.filter((role) => role.name.toLowerCase().includes(lower));
    if (partial.length === 1) {
      return { ok: true, role: partial[0]! };
    }
    if (partial.length > 1) {
      return { ok: false, reason: 'ambiguous', candidates: partial };
    }

    return { ok: false, reason: 'not-found', candidates: [] };
  }

  /** Only roles of type `User` can be attached to a person. */
  async listUserRoles(force = false): Promise<LogtoRole[]> {
    const roles = await this.list(force);
    return roles.filter((role) => role.type === 'User');
  }
}
