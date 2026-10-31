import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Repo, RoleGroupRow, RoleMappingRow } from '../db/repo.js';
import type { Logger } from '../logger.js';
import type { RoleSyncConfig, RoleSyncGroup } from './roleSync.js';

export const ROLE_CONFIG_IMPORTED_KEY = 'roles_imported_at';
const VERSION_KEY = 'role_config_version';
const CACHE_TTL_MS = 60_000;

export type MappingKind = 'status' | 'title';

/**
 * Database-backed group/role configuration.
 *
 * The DB is the single source of truth; `config/roles.json` is only a one-time
 * seed (imported when no group exists yet). Writes go through this store so the
 * in-memory cache is invalidated immediately instead of after the TTL.
 */
export class RoleConfigStore {
  private cache?: { version: number; at: number; config: RoleSyncConfig };

  constructor(
    private readonly deps: {
      repo: Repo;
      logger: Logger;
      ttlMs?: number;
    },
  ) {}

  version(): number {
    return Number(this.deps.repo.getSetting(VERSION_KEY) ?? '0');
  }

  bump(): void {
    this.deps.repo.setSetting(VERSION_KEY, String(this.version() + 1));
    this.cache = undefined;
  }

  /** Current enabled config, rebuilt from the DB when stale. */
  getConfig(): RoleSyncConfig {
    const version = this.version();
    const now = Date.now();
    const ttl = this.deps.ttlMs ?? CACHE_TTL_MS;

    if (this.cache && this.cache.version === version && now - this.cache.at < ttl) {
      return this.cache.config;
    }

    const config = this.buildConfig(false);
    this.cache = { version, at: now, config };
    return config;
  }

  buildConfig(includeDisabled: boolean): RoleSyncConfig {
    const groups = this.deps.repo
      .listRoleGroups()
      .filter((group) => includeDisabled || group.enabled === 1);
    const mappings = this.deps.repo.listRoleMappings();

    return {
      enabled: groups.length > 0,
      groups: groups.map((group) => this.toRoleSyncGroup(group, mappings)),
    };
  }

  private toRoleSyncGroup(group: RoleGroupRow, mappings: RoleMappingRow[]): RoleSyncGroup {
    const own = mappings.filter((mapping) => mapping.chat_id === group.chat_id);
    const status: Record<string, string[]> = {};
    const titles: Record<string, string> = {};

    for (const mapping of own) {
      if (mapping.kind === 'status') {
        status[mapping.key] = [...(status[mapping.key] ?? []), mapping.role_id];
      } else {
        titles[mapping.key] = mapping.role_id;
      }
    }

    return {
      chatId: group.chat_id,
      mapping: status,
      customTitleMap: titles,
      removeOnLeave: group.remove_on_leave === 1,
    };
  }

  groups(): RoleGroupRow[] {
    return this.deps.repo.listRoleGroups();
  }

  group(chatId: number): RoleGroupRow | undefined {
    return this.deps.repo.getRoleGroup(chatId);
  }

  upsertGroup(input: Parameters<Repo['upsertRoleGroup']>[0]): void {
    this.deps.repo.upsertRoleGroup(input);
    this.bump();
  }

  removeGroup(chatId: number): boolean {
    const removed = this.deps.repo.deleteRoleGroup(chatId);
    this.bump();
    return removed;
  }

  mappings(chatId?: number): RoleMappingRow[] {
    return this.deps.repo.listRoleMappings(chatId);
  }

  setMapping(input: { chatId: number; kind: MappingKind; key: string; roleId: string; actor?: number | null }): void {
    this.deps.repo.upsertRoleMapping(input);
    this.bump();
  }

  deleteMapping(chatId: number, kind: MappingKind, key: string): boolean {
    const removed = this.deps.repo.deleteRoleMapping(chatId, kind, key);
    this.bump();
    return removed;
  }

  /** One-time import from `config/roles.json` for fresh databases. */
  bootstrapFromFile(path: string): void {
    const { repo, logger } = this.deps;

    if (repo.getSetting(ROLE_CONFIG_IMPORTED_KEY)) {
      return;
    }
    if (repo.listRoleGroups().length > 0) {
      repo.setSetting(ROLE_CONFIG_IMPORTED_KEY, String(Math.floor(Date.now() / 1000)));
      return;
    }

    let parsed: RoleSyncConfig;
    try {
      parsed = JSON.parse(readFileSync(resolve(path), 'utf8')) as RoleSyncConfig;
    } catch {
      logger.debug({ path }, 'no roles seed file, starting with empty role config');
      repo.setSetting(ROLE_CONFIG_IMPORTED_KEY, String(Math.floor(Date.now() / 1000)));
      return;
    }

    const groups = Array.isArray(parsed.groups) ? parsed.groups : [];
    for (const group of groups) {
      repo.upsertRoleGroup({
        chatId: Number(group.chatId),
        enabled: parsed.enabled !== false,
        removeOnLeave: group.removeOnLeave !== false,
      });
      for (const [status, roleIds] of Object.entries(group.mapping ?? {})) {
        const [roleId] = roleIds;
        if (roleId) {
          repo.upsertRoleMapping({ chatId: Number(group.chatId), kind: 'status', key: status, roleId });
        }
      }
      for (const [title, roleId] of Object.entries(group.customTitleMap ?? {})) {
        if (roleId) {
          repo.upsertRoleMapping({ chatId: Number(group.chatId), kind: 'title', key: title, roleId });
        }
      }
    }

    repo.setSetting(ROLE_CONFIG_IMPORTED_KEY, String(Math.floor(Date.now() / 1000)));
    this.bump();
    logger.info({ groups: groups.length, path }, 'imported role config seed file');
  }

  /** JSON in the same shape as `config/roles.json`, for backups/CLI export. */
  exportJson(): RoleSyncConfig {
    return this.buildConfig(true);
  }

  importJson(config: RoleSyncConfig, actor?: number | null): { groups: number; mappings: number } {
    const { repo } = this.deps;
    let mappingCount = 0;

    for (const group of config.groups ?? []) {
      repo.upsertRoleGroup({
        chatId: Number(group.chatId),
        enabled: config.enabled !== false,
        removeOnLeave: group.removeOnLeave !== false,
        actor: actor ?? null,
      });
      for (const [status, roleIds] of Object.entries(group.mapping ?? {})) {
        for (const roleId of roleIds) {
          repo.upsertRoleMapping({
            chatId: Number(group.chatId),
            kind: 'status',
            key: status,
            roleId,
            actor: actor ?? null,
          });
          mappingCount += 1;
        }
      }
      for (const [title, roleId] of Object.entries(group.customTitleMap ?? {})) {
        repo.upsertRoleMapping({
          chatId: Number(group.chatId),
          kind: 'title',
          key: title,
          roleId,
          actor: actor ?? null,
        });
        mappingCount += 1;
      }
    }

    this.bump();
    return { groups: (config.groups ?? []).length, mappings: mappingCount };
  }
}
