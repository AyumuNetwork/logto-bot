import type { AuditRow, Repo } from '../db/repo.js';

/** Marker used for actions performed through the CLI instead of Telegram. */
export const CLI_ACTOR = 0;

/**
 * Every privileged action (Telegram command or CLI) is recorded here so the
 * tenant admin can answer "who changed the role mapping and when".
 */
export class AdminAudit {
  constructor(private readonly repo: Repo) {}

  record(input: {
    actor: number;
    action: string;
    target?: string | number | null;
    detail?: unknown;
  }): void {
    this.repo.insertAudit(
      input.actor,
      input.action,
      input.target === undefined || input.target === null ? null : String(input.target),
      input.detail,
    );
  }

  recent(limit = 15): AuditRow[] {
    return this.repo.listAudit(limit);
  }

  get actorLabel(): string {
    return 'CLI';
  }
}
