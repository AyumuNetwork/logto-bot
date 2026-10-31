import { describe, expect, it } from 'vitest';

import { openDatabase, type Database } from '../../src/db/index.js';
import { Repo } from '../../src/db/repo.js';
import { RoleConfigStore } from '../../src/services/roleConfigStore.js';

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as never;

const setup = () => {
  const db: Database = openDatabase(':memory:');
  const repo = new Repo(db);
  const store = new RoleConfigStore({ repo, logger });
  return { db, repo, store };
};

describe('RoleConfigStore', () => {
  it('starts with an empty, disabled config', () => {
    const { store } = setup();
    expect(store.getConfig()).toEqual({ enabled: false, groups: [] });
    expect(store.version()).toBe(0);
  });

  it('upserts groups and mappings, and bumps the version', () => {
    const { store } = setup();
    store.upsertGroup({ chatId: -100, enabled: true, actor: 111 });
    store.setMapping({ chatId: -100, kind: 'status', key: 'administrator', roleId: 'role_mod', actor: 111 });
    store.setMapping({ chatId: -100, kind: 'title', key: '核心成员', roleId: 'role_core', actor: 111 });

    const config = store.getConfig();
    expect(config.enabled).toBe(true);
    expect(config.groups[0]).toEqual({
      chatId: -100,
      mapping: { administrator: ['role_mod'] },
      customTitleMap: { 核心成员: 'role_core' },
      removeOnLeave: true,
    });
    expect(store.version()).toBeGreaterThan(0);
  });

  it('returns a cached config until the version changes', () => {
    const { store } = setup();
    store.upsertGroup({ chatId: -100, actor: 111 });
    const first = store.getConfig();
    const second = store.getConfig();
    expect(second).toBe(first);
  });

  it('hides disabled groups from the runtime config but keeps them in exports', () => {
    const { store } = setup();
    store.upsertGroup({ chatId: -200, enabled: true, actor: 1 });
    store.upsertGroup({ chatId: -300, enabled: false, actor: 1 });

    expect(store.getConfig().groups.map((group) => group.chatId)).toEqual([-200]);
    expect(store.exportJson().groups.map((group) => group.chatId).sort()).toEqual([-300, -200].sort());
  });

  it('deletes a group together with its mappings', () => {
    const { store, repo } = setup();
    store.upsertGroup({ chatId: -100, actor: 1 });
    store.setMapping({ chatId: -100, kind: 'status', key: 'member', roleId: 'role_member', actor: 1 });

    expect(store.removeGroup(-100)).toBe(true);
    expect(repo.listRoleMappings(-100)).toEqual([]);
    expect(store.getConfig().groups).toEqual([]);
  });

  it('imports an export losslessly', () => {
    const source = setup();
    source.store.upsertGroup({ chatId: -100, actor: 1, title: '主群' });
    source.store.setMapping({ chatId: -100, kind: 'status', key: 'creator', roleId: 'role_admin', actor: 1 });

    const target = setup();
    const counts = target.store.importJson(source.store.exportJson(), 0);
    expect(counts).toEqual({ groups: 1, mappings: 1 });
    expect(target.store.getConfig().groups[0]?.mapping).toEqual({ creator: ['role_admin'] });
  });
});
