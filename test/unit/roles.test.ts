import { describe, expect, it } from 'vitest';

import { RoleResolver } from '../../src/services/roles.js';
import type { LogtoRole } from '../../src/logto/management.js';

const logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined } as never;

const ROLES: LogtoRole[] = [
  { id: 'role_external', name: 'External Users', type: 'User', isDefault: true },
  { id: 'role_internal', name: 'Internal Users', type: 'User', isDefault: false },
  { id: 'role_admin', name: 'Admins', type: 'User', isDefault: false },
  { id: 'role_m2m', name: 'Logto Management API access', type: 'MachineToMachine', isDefault: false },
];

const setup = () => {
  let calls = 0;
  const management = {
    listRoles: async () => {
      calls += 1;
      return ROLES;
    },
  } as never;
  const resolver = new RoleResolver({ management, logger, ttlMs: 60_000 });
  return { resolver, calls: () => calls };
};

describe('RoleResolver', () => {
  it('resolves by exact id, name and case-insensitive name', async () => {
    const { resolver } = setup();
    await expect(resolver.resolve('role_admin')).resolves.toMatchObject({ ok: true });
    await expect(resolver.resolve('Admins')).resolves.toMatchObject({ ok: true });
    const lower = await resolver.resolve('admins');
    expect(lower.ok && lower.role.id).toBe('role_admin');
  });

  it('resolves a unique substring', async () => {
    const { resolver } = setup();
    const result = await resolver.resolve('Intern');
    expect(result.ok && result.role.id).toBe('role_internal');
  });

  it('reports ambiguity instead of guessing', async () => {
    const { resolver } = setup();
    const result = await resolver.resolve('users');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('ambiguous');
    expect(result.ok === false && result.candidates).toHaveLength(2);
  });

  it('reports a miss', async () => {
    const { resolver } = setup();
    const result = await resolver.resolve('nonexistent');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('not-found');
  });

  it('caches role lists until invalidated', async () => {
    const { resolver, calls } = setup();
    await resolver.resolve('Admins');
    await resolver.resolve('Admins');
    expect(calls()).toBe(1);
    resolver.invalidate();
    await resolver.resolve('Admins');
    expect(calls()).toBe(2);
  });

  it('only returns user roles for people', async () => {
    const { resolver } = setup();
    const roles = await resolver.listUserRoles();
    expect(roles.every((role) => role.type === 'User')).toBe(true);
  });
});
