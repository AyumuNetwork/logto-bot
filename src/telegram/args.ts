export type ParsedArgs = {
  positional: string[];
  flags: Record<string, string | true>;
  multi: Record<string, string[]>;
};

/**
 * Tiny argv parser for bot commands: supports `--flag`, `--key value` and
 * repeated keys (`--org a --org b`). Everything else is positional.
 */
export const parseArgs = (raw: unknown): ParsedArgs => {
  const text = typeof raw === 'string' ? raw : '';
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  const multi: Record<string, string[]> = {};

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = tokens[index + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      multi[key] = [...(multi[key] ?? []), next];
      index += 1;
    } else {
      flags[key] = true;
      multi[key] = [...(multi[key] ?? []), ''];
    }
  }

  return { positional, flags, multi };
};

export const flagString = (args: ParsedArgs, key: string): string | undefined => {
  const value = args.flags[key];
  return typeof value === 'string' ? value : undefined;
};

export const flagNumber = (args: ParsedArgs, key: string): number | undefined => {
  const value = flagString(args, key);
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

export const flagList = (args: ParsedArgs, key: string): string[] =>
  (args.multi[key] ?? []).filter(Boolean);

export const flagBool = (args: ParsedArgs, key: string): boolean => args.flags[key] !== undefined;
