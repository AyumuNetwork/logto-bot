import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Logger } from '../logger.js';

export type LoginTarget = {
  /** Contact the user sees, e.g. "Logto 账户中心" */
  label: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  /** `ott` = one-time token magic link, `sso` = plain authorize (only works with a session) */
  mode: 'ott' | 'sso';
  /** When set, the link logs into a specific app instead of the account center. */
  app?: string;
};

export type LoginTargets = {
  defaultSlug: string;
  targets: Record<string, LoginTarget>;
};

export const DEFAULT_TARGETS: LoginTargets = {
  defaultSlug: 'account',
  targets: {},
};

/**
 * Load `config/apps.json`. Shape:
 * {
 *   "defaultSlug": "account",
 *   "targets": {
 *     "account": { "label": "Logto 账户中心", "clientId": "...", "redirectUri": "https://auth.haori.ink/" },
 *     "git":     { "label": "GitLab", "clientId": "...", "redirectUri": "https://git.haori.ink/..." }
 *   }
 * }
 */
export const loadLoginTargets = (path: string, logger: Logger): LoginTargets => {
  try {
    const raw = readFileSync(resolve(path), 'utf8');
    const parsed = JSON.parse(raw) as Partial<LoginTargets>;
    const targets = parsed.targets ?? {};
    return {
      defaultSlug: parsed.defaultSlug ?? 'account',
      targets: Object.fromEntries(
        Object.entries(targets).map(([slug, value]) => [
          slug,
          {
            label: value.label ?? slug,
            clientId: value.clientId,
            redirectUri: value.redirectUri,
            scope: value.scope ?? 'openid profile',
            mode: value.mode ?? 'ott',
            app: value.app,
          },
        ]),
      ),
    };
  } catch (error) {
    logger.warn({ path, error: (error as Error).message }, 'login targets config not loaded, using defaults');
    return DEFAULT_TARGETS;
  }
};
