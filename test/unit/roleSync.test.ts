import { describe, expect, it } from 'vitest';

import { desiredRoles, type RoleSyncGroup } from '../../src/services/roleSync.js';

const group: RoleSyncGroup = {
  chatId: -1001234567890,
  mapping: {
    creator: ['role_admin'],
    administrator: ['role_mod'],
    member: ['role_member'],
  },
  customTitleMap: { 核心成员: 'role_core' },
  removeOnLeave: true,
};

describe('desiredRoles', () => {
  it('maps creator to admin role', () => {
    expect(desiredRoles(group, { status: 'creator' })).toEqual({ roles: ['role_admin'], leaving: false });
  });

  it('maps administrator and member', () => {
    expect(desiredRoles(group, { status: 'administrator' }).roles).toEqual(['role_mod']);
    expect(desiredRoles(group, { status: 'member' }).roles).toEqual(['role_member']);
  });

  it('adds custom title roles on top of the status mapping', () => {
    expect(desiredRoles(group, { status: 'administrator', custom_title: '核心成员' }).roles).toEqual([
      'role_mod',
      'role_core',
    ]);
  });

  it('ignores unknown custom titles and restricted states', () => {
    expect(desiredRoles(group, { status: 'restricted', custom_title: '核心成员' }).roles).toEqual(['role_core']);
    expect(desiredRoles(group, { status: 'member', custom_title: 'unknown' }).roles).toEqual(['role_member']);
  });

  it('marks left/kicked members as leaving with no roles', () => {
    expect(desiredRoles(group, { status: 'left' })).toEqual({ roles: [], leaving: true });
    expect(desiredRoles(group, { status: 'kicked' })).toEqual({ roles: [], leaving: true });
  });
});
