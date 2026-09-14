/**
 * unprocessed-artifacts — a file was handed in and nothing ever came of it.
 *
 * This is the one sentinel that reads across the schema line, and it does so
 * deliberately and read-only: the question "did anything in the ledger come
 * out of this document?" can only be asked from the side that owns the ledger.
 * `core.artifacts` is never written here, and the three references it checks
 * are all finance's own columns.
 */
import { localDateString } from '@buddi/core';
import { unprocessedArtifactsFinding, UNPROCESSED_ARTIFACT_HOURS, type UnprocessedArtifact } from './helpers.js';
import { EVERY_6H, type Finding, type Sentinel, type SentinelContext } from './types.js';

export const unprocessedArtifacts: Sentinel = {
  id: 'finance.unprocessed-artifacts',
  description:
    'Reports files handed in more than a day ago that no transaction, receipt or staged import references.',
  every: EVERY_6H,
  async run(ctx: SentinelContext): Promise<Finding[]> {
    const now = ctx.now();
    const { rows } = await ctx.db.query(
      `select a.id, a.filename, a.kind, a.mime, a.created_at
         from core.artifacts a
        where a.deleted_at is null
          and a.created_at < $1::timestamptz - interval '${UNPROCESSED_ARTIFACT_HOURS} hours'
          and not exists (select 1 from finance.transactions t where t.artifact_id = a.id)
          and not exists (select 1 from finance.receipts r where r.artifact_id = a.id)
          and not exists (select 1 from finance.import_stagings s where s.artifact_id = a.id)
        order by a.created_at`,
      [now.toISOString()],
    );
    const artifacts: UnprocessedArtifact[] = rows.map((r) => {
      const createdAt = r.created_at instanceof Date ? r.created_at : new Date(String(r.created_at));
      return {
        id: String(r.id),
        filename: (r.filename as string | null) ?? null,
        kind: r.kind as string,
        mime: r.mime as string,
        createdOn: localDateString(createdAt, ctx.timezone),
        ageHours: Math.floor((now.getTime() - createdAt.getTime()) / 3_600_000),
      };
    });
    const finding: Finding | null = unprocessedArtifactsFinding(artifacts);
    return finding === null ? [] : [finding];
  },
};
