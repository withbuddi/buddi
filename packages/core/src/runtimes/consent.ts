/**
 * The one card behind a local-model download (docs/plugin-host-api.md §4.2
 * `onnx`, 1.32).
 *
 * A plugin asks with `ctx.buddi.onnx.ensure({ reason, model })` or
 * `ctx.buddi.models.ensure(...)`; nothing is fetched until the owner says
 * yes. The card covers what is missing in one question — "Download the
 * Whisper base model (135 MB) and the engine that runs it (114 MB)?" — and
 * approving it runs core's own `runtimes.download`, which starts both
 * downloads. An engine that is already there is not asked about again, so a
 * second plugin that only needs the engine gets no card.
 *
 * The card is an ordinary action on the existing path (`createAction`), the
 * way an owner secret's use is: it reaches every surface the owner decides
 * on. While one is pending for the same thing, asking again answers that card
 * instead of raising another.
 */
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { createAction } from '../actions/store.js';
import type { ActionRecord } from '../actions/types.js';
import type { CoreToolContext, EffectDescription, PluginManifest, ToolDefinition } from '../tools.js';
import { formatDownloadSize } from './download.js';
import { checkModelRequest, markModelApproved, startModelDownload, type ModelFile } from './models.js';
import { markOnnxApproved, onnxState, startOnnxDownload } from './onnx.js';

export const RUNTIMES_PLUGIN = 'runtimes';
export const RUNTIMES_TOOL = 'runtimes.download';
export const RUNTIMES_TOOL_VERSION = '1.0.0';

const fileSchema = z
  .object({ url: z.string(), sha256: z.string(), bytes: z.number().int().positive(), name: z.string() })
  .strict();

const input = z
  .object({
    /** What the card is about, so a second ask for the same thing finds it. */
    key: z.string(),
    plugin: z.string(),
    reason: z.string(),
    engine: z
      .object({ version: z.string(), platform: z.string(), downloadBytes: z.number().int(), sizeBytes: z.number().int() })
      .strict()
      .optional(),
    model: z
      .object({
        name: z.string(),
        bytes: z.number().int().nonnegative(),
        /** A shared model core downloads into `models/<id>/`. */
        id: z.string().optional(),
        files: z.array(fileSchema).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type RuntimesDownload = z.infer<typeof input>;

/** The card's question, and what it will do. Deterministic in its arguments. */
export function describeRuntimesDownload(args: RuntimesDownload): EffectDescription {
  const model = args.model;
  const engine = args.engine;
  const modelText = model ? `the ${model.name}${model.bytes > 0 ? ` (${formatDownloadSize(model.bytes)})` : ''}` : '';
  const question =
    model && engine
      ? `Download ${modelText} and the engine that runs it (${formatDownloadSize(engine.downloadBytes)})?`
      : engine
        ? `Download the engine that runs local models (${formatDownloadSize(engine.downloadBytes)})?`
        : `Download ${modelText}?`;
  const reason = args.reason.trim();
  const lines = [`${args.plugin} asks: ${/[.!?…]$/.test(reason) ? reason : `${reason}.`}`];
  if (engine) {
    lines.push(
      `The engine is ONNX Runtime ${engine.version} for this computer (${engine.platform}), from npm, checked against its pinned checksum; ` +
        `${formatDownloadSize(engine.sizeBytes)} stays on disk, shared by every plugin that runs local models.`,
    );
  }
  if (model?.files) lines.push(`The model's ${model.files.length === 1 ? 'file is' : `${model.files.length} files are`} checked against their pinned checksums too.`);
  return {
    envelope: {
      plugin: args.plugin,
      reason: args.reason,
      ...(engine ? { engine } : {}),
      ...(model ? { model: { name: model.name, bytes: model.bytes, ...(model.id ? { id: model.id } : {}), ...(model.files ? { files: model.files.map((f) => ({ url: f.url, sha256: f.sha256, bytes: f.bytes })) } : {}) } } : {}),
    },
    // The question on a line of its own: it is the card's heading on Telegram and in notifications.
    preview: `${question}\n${lines.join(' ')}`,
  };
}

const downloadTool: ToolDefinition<RuntimesDownload, unknown> = {
  name: RUNTIMES_TOOL,
  description: "Start a local-model download the owner approved. Runs only from an approved action.",
  tier: 'gated',
  ownerOnly: true,
  input,
  describe: (args) => describeRuntimesDownload(args),
  async execute(args, _ctx: CoreToolContext) {
    const started: string[] = [];
    if (args.engine) {
      // The yes is kept until the download ends: a restart mid-way resumes it on the next ensure.
      await markOnnxApproved().catch(() => {});
      void startOnnxDownload();
      started.push('engine');
    }
    if (args.model?.id && args.model.files) {
      try {
        const checked = checkModelRequest({ id: args.model.id, files: args.model.files });
        await markModelApproved(checked.id, checked.files).catch(() => {});
        void startModelDownload({ id: args.model.id, files: args.model.files }).catch(() => {});
        started.push(`model ${args.model.id}`);
      } catch (err) {
        return { started, refused: err instanceof Error ? err.message : String(err) };
      }
    }
    return {
      started,
      note: started.length === 0 ? 'Nothing to download.' : `Downloading ${started.join(' and ')}; ${args.plugin} can use it once it is ready.`,
    };
  },
};

/** Core's manifest for the approval tool. Registered by the gateway beside the other core families. */
export function createRuntimesManifest(): PluginManifest {
  return {
    name: RUNTIMES_PLUGIN,
    version: RUNTIMES_TOOL_VERSION,
    schema: 'core',
    migrationsDir: '',
    tools: [downloadTool],
  } as PluginManifest;
}

/** What a plugin hands `ensure` about its model. */
export interface EnsureModel {
  /** How the owner reads it: "Whisper base model". */
  name?: string;
  /** Its size, when the plugin downloads it itself. */
  bytes?: number;
  /** A shared model core downloads (`models.ensure`'s `id` and `files`). */
  id?: string;
  files?: readonly ModelFile[];
}

export interface CardFacts {
  pool: Pool;
  plugin: string;
  agentId?: string | undefined;
  conversationId?: string | undefined;
  now: () => Date;
  /** Tells the owner's channels (Telegram, push) a card is waiting; the composition root's. */
  askApproval?: ((action: ActionRecord) => Promise<void>) | undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The arguments of the card for what is missing, or undefined when nothing is.
 * `engine` is whether the engine must come too. Throws a `ModelRefusal` for a
 * model that is not one.
 */
export function downloadArgs(plugin: string, reason: string, engine: boolean, model: EnsureModel | undefined): RuntimesDownload | undefined {
  if (typeof reason !== 'string' || reason.trim() === '') throw new TypeError('ensure needs a reason the owner reads on the card');
  let modelArgs: RuntimesDownload['model'];
  if (model !== undefined) {
    if (model.files !== undefined || model.id !== undefined) {
      const checked = checkModelRequest({ id: model.id ?? '', files: model.files ?? [] });
      modelArgs = { name: clip(model.name ?? checked.id), bytes: checked.bytes, id: checked.id, files: checked.files };
    } else {
      const bytes = model.bytes ?? 0;
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw new TypeError('a model\'s bytes are a whole number');
      modelArgs = { name: clip(model.name ?? 'model'), bytes };
    }
  }
  const state = onnxState();
  const engineArgs = engine ? { version: state.version, platform: state.platform, downloadBytes: state.downloadBytes, sizeBytes: state.sizeBytes } : undefined;
  if (engineArgs === undefined && modelArgs === undefined) return undefined;
  const key = `${engineArgs ? `onnx@${engineArgs.version}/${engineArgs.platform}` : ''}|${modelArgs ? (modelArgs.id ?? `named:${modelArgs.name}`) : ''}`;
  return { key, plugin, reason: clip(reason.trim(), 280), ...(engineArgs ? { engine: engineArgs } : {}), ...(modelArgs ? { model: modelArgs } : {}) };
}

function clip(text: string, max = 80): string {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** One raise at a time in this process; the database lock covers every process. */
let raising: Promise<unknown> = Promise.resolve();

/**
 * Raise the card, or answer the one already pending for the same thing.
 * Answers the action id. The lookup and the insert run under one advisory
 * lock in one transaction, so two plugins asking in the same tick (speech and
 * news at boot) get one card between them, not two.
 */
export function raiseDownloadCard(facts: CardFacts, args: RuntimesDownload): Promise<string> {
  const next = raising.then(() => raiseLocked(facts, args));
  raising = next.catch(() => {});
  return next;
}

async function raiseLocked(facts: CardFacts, args: RuntimesDownload): Promise<string> {
  const client: PoolClient = await facts.pool.connect();
  let created: ActionRecord | undefined;
  let id: string;
  try {
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [RUNTIMES_TOOL]);
    // The engine alone is answered by any pending card that brings it: the
    // owner is asked about the engine once, whichever plugin asked first.
    const engineOnly = args.engine !== undefined && args.model === undefined;
    const { rows } = await client.query(
      `select a.id from core.actions a join core.approvals p on p.action_id = a.id
        where a.tool = $1 and p.state = 'pending' and a.expires_at > $3
          and (a.canonical_args->>'key' = $2 or ($4 and starts_with(a.canonical_args->>'key', $2)))
        order by a.created_at desc limit 1`,
      [RUNTIMES_TOOL, args.key, facts.now(), engineOnly],
    );
    const open = rows[0] as { id: string } | undefined;
    if (open !== undefined) {
      id = String(open.id);
    } else {
      const card = describeRuntimesDownload(args);
      let conversationId: string | null = null;
      if (facts.conversationId !== undefined && UUID.test(facts.conversationId)) {
        const found = await client.query(`select 1 from core.conversations where id = $1`, [facts.conversationId]);
        if (found.rows.length > 0) conversationId = facts.conversationId;
      }
      created = await createAction(client, {
        tool: RUNTIMES_TOOL,
        toolVersion: RUNTIMES_TOOL_VERSION,
        agentId: facts.agentId ?? facts.plugin,
        conversationId,
        canonicalArgs: args,
        envelope: card.envelope,
        preview: card.preview,
        tier: 'gated',
        now: facts.now(),
      });
      id = created.id;
    }
    await client.query('commit');
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  // Telegram and push are told about a new card; telling them never fails the ask.
  if (created !== undefined && facts.askApproval !== undefined) {
    await facts.askApproval(created).catch(() => {});
  }
  return id;
}
