import { describe, expect, it } from 'vitest';

import { parseArgs, flagBool, flagList, flagNumber, flagString } from '../../src/telegram/args.js';

describe('parseArgs', () => {
  it('collects positional tokens', () => {
    const args = parseArgs('status administrator Admins');
    expect(args.positional).toEqual(['status', 'administrator', 'Admins']);
  });

  it('parses value flags and boolean flags', () => {
    const args = parseArgs('a@b.c --ttl 600 --yes --org org_1 --org org_2');
    expect(args.positional).toEqual(['a@b.c']);
    expect(flagNumber(args, 'ttl')).toBe(600);
    expect(flagBool(args, 'yes')).toBe(true);
    expect(flagString(args, 'org')).toBe('org_2'); // last occurrence wins, use flagList for all
    expect(flagList(args, 'org')).toEqual(['org_1', 'org_2']);
  });

  it('keeps role names with spaces positional', () => {
    const args = parseArgs('title 核心成员 Very Internal Users');
    expect(args.positional.slice(2).join(' ')).toBe('Very Internal Users');
  });

  it('tolerates non-string match values from grammY', () => {
    expect(parseArgs(undefined).positional).toEqual([]);
    expect(parseArgs(['ignored']).positional).toEqual([]);
  });

  it('treats trailing flags without value as boolean', () => {
    const args = parseArgs('--apply');
    expect(flagBool(args, 'apply')).toBe(true);
  });
});
