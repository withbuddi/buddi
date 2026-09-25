/**
 * Settings → Keys and secrets (docs/specs/owner-secrets.md §6).
 *
 * The owner's vault, next to Model accounts and Computer & browser under the
 * same question: what agents may reach. Each row is a secret — a name, where
 * its value may go (the bindings, each a destination kind, a target and a
 * rule), the last use and its use log. The value itself this page never shows
 * again after a save: the add form takes it once, in a password field, and
 * "Replace value" is the only way it changes. Every write is an ownerOnly
 * tool invoked as the owner through the act route, so no model ever sees one,
 * and a refused one answers beside the button that asked.
 *
 * buddi's own keys sit at the bottom, read-only: the vault is one place, so
 * the page shows everything it holds.
 */
import { useMemo, useState } from 'react';
import { api, type SecretListingView, type SecretRule, type SecretsView } from '../api';
import { fmtRelative, fmtTime } from '../format';
import { Button, Empty, ErrorBanner, Field, Notice, PageFrame, Pill, Section, Sheet, Stack, Tag, Toolbar, useAsync, EmptyState } from '../ui';
import {
  ACCOUNT_HELD_LINE,
  RULE_LABELS,
  UNBOUND_LINE,
  allowedRules,
  foundSentence,
  outcomeTone,
  parseTargetInput,
  accountOf,
  renderPlace,
  scrubbedSentence,
  type AccountName,
  targetInputText,
  targetPlaceholder,
} from './secret-rules';
import { providerName } from './Providers';

/** One write: the tool invoked as the owner, its answer or `null` on a refusal. */
async function writeSecret(
  tool: Parameters<typeof api.secretsAct>[0],
  args: Record<string, unknown>,
  setBusy: (busy: boolean) => void,
  setFailure: (message: string | null) => void,
): Promise<unknown | null> {
  setBusy(true);
  setFailure(null);
  try {
    const answer = await api.secretsAct(tool, args);
    return answer.result;
  } catch (error) {
    setFailure(error instanceof Error ? error.message : String(error));
    return null;
  } finally {
    setBusy(false);
  }
}

/** One binding as the form holds it: the target still the owner's text. */
interface BindingDraft {
  kind: string;
  target: string;
  rule: SecretRule;
}

export function Secrets({ embedded, timezone }: { embedded?: boolean; timezone?: string } = {}): JSX.Element {
  const view = useAsync(() => api.secrets(), []);
  // A model account's credential is stored under a generated name; the page names it by its account.
  const providerAccounts = useAsync(() => api.providerAccounts(), []);
  const accounts = useMemo(
    () => new Map<string, AccountName>((providerAccounts.data?.accounts ?? []).map((a) => [a.id, { label: a.label, provider: providerName(a) }])),
    [providerAccounts.data],
  );
  const [adding, setAdding] = useState(false);
  const data: SecretsView | undefined = view.data;
  return (
    <PageFrame
      embedded={embedded}
      title="Keys and secrets"
      lede="What the agents may use and never see: a name, a value buddi keeps, and the exact places the value may go."
    >
      <Stack gap="lg">
        {!data && !view.error ? <Empty>Opening the vault…</Empty> : null}
        {view.error ? (
          <Toolbar>
            <Button onClick={view.reload}>Retry</Button>
          </Toolbar>
        ) : null}
        {data ? (
          <Section
            title="Secrets"
            aside="A value the agents use and never see: bound to where it may go, never shown again."
            actions={
              <Button variant="accent" size="sm" onClick={() => setAdding(true)}>
                Add a secret
              </Button>
            }
            panel
          >
            <Stack divided>
              {data.secrets.length === 0 ? (
                <EmptyState icon="key" title="Nothing stored yet">
                  Add one — a site password, an API token — and bind it to the places an agent may use it.
                </EmptyState>
              ) : (
                data.secrets.map((secret) => (
                  <SecretRow key={secret.name} secret={secret} accounts={accounts} destinations={data.destinations} timezone={timezone} onChanged={view.reload} />
                ))
              )}
            </Stack>
          </Section>
        ) : null}
        {data ? (
          <Section title="buddi’s own keys" aside="Read-only.">
            <Stack gap="sm">
              {data.ownKeys.length === 0 ? (
                <Empty>No keys of buddi’s own right now.</Empty>
              ) : (
                <div className="ui-list">
                  {data.ownKeys.map((key) => (
                    <div key={key} className="ui-list-row">
                      <span className="ui-list-main">
                        <span className="mono">{key}</span>
                      </span>
                    </div>
                  ))}
                </div>
              )}
              <p className="ui-card-meta">
                These are the keys buddi itself runs on. They cannot be bound or replaced here, and the scrubber
                replaces them in what buddi sends out, exactly like your own secrets.
              </p>
            </Stack>
          </Section>
        ) : null}
      </Stack>
      {adding && data ? (
        <AddSecretSheet destinations={data.destinations} onClose={() => setAdding(false)} onChanged={view.reload} />
      ) : null}
    </PageFrame>
  );
}

/** One secret: its bindings, its last use, its log, and the owner's own actions. */
function SecretRow({
  secret,
  accounts,
  destinations,
  timezone,
  onChanged,
}: {
  secret: SecretListingView;
  accounts: ReadonlyMap<string, AccountName>;
  destinations: SecretsView['destinations'];
  timezone?: string;
  onChanged: () => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [sheet, setSheet] = useState<'replace' | 'rename' | 'rebind' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const del = async (): Promise<void> => {
    const result = await writeSecret('secrets.delete', { name: secret.name }, setBusy, setFailure);
    if (result !== null) {
      setConfirmDelete(false);
      onChanged();
    }
  };
  const last = secret.lastUse;
  const account = accountOf(secret.bindings, accounts);
  return (
    <Stack gap="sm">
      <div className="ui-card-head">
        <h3 className="ui-card-title">{account ? account.label : secret.name}</h3>
        {account ? <Tag>{account.provider}</Tag> : null}
        {secret.totp ? <Tag>TOTP</Tag> : null}
        {last ? <Pill tone={outcomeTone(last.outcome)}>{last.outcome}</Pill> : null}
      </div>
      {account ? <p className="ui-card-meta mono">{secret.name}</p> : null}
      {secret.bindings.length === 0 ? (
        <p className="ui-card-meta">{UNBOUND_LINE}</p>
      ) : (
        <div className="ui-stack" data-gap="sm">
          {secret.bindings.map((binding, index) => (
            <div key={index} className="ui-row">
              <Tag>{binding.kind}</Tag>
              <span className="mono">{renderPlace(binding.kind, binding.target, accounts)}</span>
              <Pill tone="muted">{RULE_LABELS[binding.rule] ?? binding.rule}</Pill>
            </div>
          ))}
        </div>
      )}
      {secret.bindings.some((binding) => binding.heldByPlugin) ? <p className="ui-card-meta">{ACCOUNT_HELD_LINE}</p> : null}
      <p className="ui-card-meta">
        {last
          ? `Last used ${fmtRelative(last.at)}${last.agentId ? ` by ${last.agentId}` : ''} — ${last.kind}, ${renderPlace(last.kind, last.target, accounts)}.`
          : 'Never used.'}
      </p>
      <ErrorBanner message={failure} />
      {confirmDelete ? (
        <Notice tone="critical" role="alert">
          <p>
            Delete “{secret.name}”? The value and its bindings go; the use log stays, under the name.
          </p>
          <Toolbar>
            <Button variant="danger" disabled={busy} onClick={() => void del()}>
              Delete it
            </Button>
            <Button disabled={busy} onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
          </Toolbar>
        </Notice>
      ) : null}
      <Toolbar>
        <Button size="sm" disabled={busy} onClick={() => setSheet('replace')}>
          Replace value
        </Button>
        <Button size="sm" disabled={busy} onClick={() => setSheet('rename')}>
          Rename
        </Button>
        <Button size="sm" disabled={busy} onClick={() => setSheet('rebind')}>
          {secret.bindings.length === 0 ? 'Add a binding' : 'Rebind'}
        </Button>
        <Button size="sm" variant="danger" disabled={busy} onClick={() => setConfirmDelete(true)}>
          Delete
        </Button>
        <Button size="sm" variant="ghost" aria-expanded={logOpen} onClick={() => setLogOpen(!logOpen)}>
          Use log
        </Button>
      </Toolbar>
      {logOpen ? <UseLog name={secret.name} accounts={accounts} timezone={timezone} /> : null}
      {sheet === 'replace' ? (
        <ReplaceValueSheet secret={secret} onClose={() => setSheet(null)} onChanged={onChanged} />
      ) : null}
      {sheet === 'rename' ? <RenameSheet secret={secret} onClose={() => setSheet(null)} onChanged={onChanged} /> : null}
      {sheet === 'rebind' ? (
        <RebindSheet secret={secret} destinations={destinations} onClose={() => setSheet(null)} onChanged={onChanged} />
      ) : null}
    </Stack>
  );
}

/** One secret's use log, asked for when the row is opened, newest first. */
function UseLog({ name, accounts, timezone }: { name: string; accounts: ReadonlyMap<string, AccountName>; timezone?: string }): JSX.Element {
  const log = useAsync(() => api.secretUses(name, 50), [name]);
  if (log.error) return <ErrorBanner message={log.error} />;
  if (!log.data) return <Empty>Reading the log…</Empty>;
  const uses = log.data.uses;
  if (uses.length === 0) return <Empty>No uses yet.</Empty>;
  return (
    <div className="ui-list">
      {uses.map((use, index) => (
        <div key={index} className="ui-list-row">
          <span className="ui-list-main">
            <span className="ui-list-title">
              {fmtTime(use.at, timezone ?? 'UTC')} — {use.kind}, {renderPlace(use.kind, use.target, accounts)}
            </span>
            <span className="ui-list-sub">
              {use.agent ? use.agent : 'the owner'}
              {use.plugin ? ` · ${use.plugin}` : ''}
              {use.detail ? ` · ${use.detail}` : ''}
            </span>
          </span>
          <span className="ui-list-side">
            <Pill tone={outcomeTone(use.outcome)}>{use.outcome}</Pill>
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * What a save came back with: the value is not coming back, but where it
 * already sits is (§6) — one line, and the one tap that scrubs it.
 */
function SavedReport({
  name,
  result,
  scrubbed,
  busy,
  failure,
  onScrub,
  onDone,
}: {
  name: string;
  result: unknown;
  scrubbed: unknown;
  busy: boolean;
  failure: string | null;
  onScrub: () => void;
  onDone: () => void;
}): JSX.Element {
  const found = foundSentence(result);
  return (
    <Stack gap="sm">
      <Notice tone="good" role="status">
        Saved “{name}”. Its value is never shown again.
      </Notice>
      <p className="ui-card-meta">{found || 'Nothing of the value sits where buddi already holds text.'}</p>
      <ErrorBanner message={failure} />
      {found ? (
        <Toolbar>
          <Button variant="accent" disabled={busy || scrubbed !== null} onClick={onScrub}>
            {scrubbed === null ? 'Scrub the history' : scrubbedSentence(scrubbed) || 'Nothing of it was left to replace.'}
          </Button>
        </Toolbar>
      ) : null}
      <Toolbar align="end">
        <Button onClick={onDone}>Done</Button>
      </Toolbar>
    </Stack>
  );
}

/** The bindings one form is editing: kind, target and rule, one row each. */
function BindingEditor({
  destinations,
  bindings,
  disabled,
  onChange,
}: {
  destinations: SecretsView['destinations'];
  bindings: BindingDraft[];
  disabled: boolean;
  onChange: (next: BindingDraft[]) => void;
}): JSX.Element {
  const change = (index: number, next: Partial<BindingDraft>): void => {
    onChange(bindings.map((binding, at) => (at === index ? { ...binding, ...next } : binding)));
  };
  return (
    <Stack gap="sm">
      {bindings.map((binding, index) => {
        const destination = destinations.find((d) => d.kind === binding.kind);
        // A kind the page no longer knows (its plugin went away) can only
        // stay as strict as the binding already is.
        const loosest = destination?.maxRule ?? binding.rule;
        return (
          <Toolbar key={index} valign="end">
            <Field label="Kind" inline>
              <select
                value={binding.kind}
                disabled={disabled}
                onChange={(event) => {
                  const kind = event.target.value;
                  change(index, { kind, rule: destinations.find((d) => d.kind === kind)?.maxRule ?? binding.rule });
                }}
              >
                {(destination ? destinations : [...destinations, { kind: binding.kind, plugin: '', maxRule: binding.rule }]).map((d) => (
                  <option key={d.kind} value={d.kind}>
                    {d.kind}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Target" inline grow>
              <input
                type="text"
                spellCheck={false}
                disabled={disabled}
                value={binding.target}
                placeholder={targetPlaceholder(binding.kind)}
                onChange={(event) => change(index, { target: event.target.value })}
              />
            </Field>
            <Field label="Rule" inline>
              <select value={binding.rule} disabled={disabled} onChange={(event) => change(index, { rule: event.target.value as SecretRule })}>
                {allowedRules(loosest).map((rule) => (
                  <option key={rule} value={rule}>
                    {RULE_LABELS[rule]}
                  </option>
                ))}
              </select>
            </Field>
            <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onChange(bindings.filter((_, at) => at !== index))}>
              Remove
            </Button>
          </Toolbar>
        );
      })}
    </Stack>
  );
}

/** The add form: the one place the owner types a value, which this page never shows again. */
function AddSecretSheet({
  destinations,
  onClose,
  onChanged,
}: {
  destinations: SecretsView['destinations'];
  onClose: () => void;
  onChanged: () => void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [totp, setTotp] = useState(false);
  const [bindings, setBindings] = useState<BindingDraft[]>(() =>
    destinations.length ? [{ kind: destinations[0]!.kind, target: '', rule: destinations[0]!.maxRule }] : [],
  );
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ name: string; result: unknown } | null>(null);
  const [scrubbed, setScrubbed] = useState<unknown>(null);
  const save = async (): Promise<void> => {
    const parsed = bindings.map((binding) => parseTargetInput(binding.kind, binding.target));
    const bad = parsed.findIndex((parse) => !parse.ok);
    if (bad !== -1) {
      setFailure(`Binding ${bad + 1}: ${(parsed[bad] as { ok: false; error: string }).error}`);
      return;
    }
    const typed = value;
    setValue('');
    const result = await writeSecret(
      'secrets.put',
      {
        name: name.trim(),
        value: typed,
        totp,
        bindings: bindings.map((binding, index) => ({
          kind: binding.kind,
          target: (parsed[index] as { ok: true; target: unknown }).target,
          rule: binding.rule,
        })),
      },
      setBusy,
      setFailure,
    );
    if (result !== null) {
      setSaved({ name: name.trim(), result });
      onChanged();
    }
  };
  const scrub = async (): Promise<void> => {
    const result = await writeSecret('secrets.scrub_history', { name: saved?.name ?? '' }, setBusy, setFailure);
    if (result !== null) {
      setScrubbed(result);
      onChanged();
    }
  };
  return (
    <Sheet title="Add a secret" onClose={onClose}>
      {saved ? (
        <SavedReport
          name={saved.name}
          result={saved.result}
          scrubbed={scrubbed}
          busy={busy}
          failure={failure}
          onScrub={() => void scrub()}
          onDone={onClose}
        />
      ) : (
        <form
          className="ui-stack"
          data-gap="sm"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <fieldset disabled={busy} className="ui-stack" data-gap="sm">
            <Field label="Name" hint="What an agent calls it. Saving a name that exists replaces that secret’s value.">
              <input required autoFocus maxLength={200} value={name} onChange={(event) => setName(event.target.value)} placeholder="PNC password" />
            </Field>
            <Field label="Value" hint="Kept in the vault, never shown again — not even here.">
              <input type="password" autoComplete="new-password" spellCheck={false} required value={value} onChange={(event) => setValue(event.target.value)} />
            </Field>
            <label className="backup-check">
              <input type="checkbox" checked={totp} onChange={(event) => setTotp(event.target.checked)} />
              <span>The code comes from this secret</span>
            </label>
            <p className="ui-field-hint">
              The seed and the code are one thing buddi holds — the owner’s explicit choice per secret.
            </p>
            <div className="ui-stack" data-gap="sm">
              <span className="ui-field-label">Bindings — the places this value may go</span>
              <BindingEditor destinations={destinations} bindings={bindings} disabled={busy} onChange={setBindings} />
              {bindings.length === 0 ? <p className="ui-field-hint">{UNBOUND_LINE}</p> : null}
              {destinations.length ? (
                <Toolbar>
                  <Button
                    size="sm"
                    onClick={() =>
                      setBindings([...bindings, { kind: destinations[0]!.kind, target: '', rule: destinations[0]!.maxRule }])
                    }
                  >
                    Add a binding
                  </Button>
                </Toolbar>
              ) : (
                <p className="ui-field-hint">No destination is registered on this installation yet, so there is nothing to bind to.</p>
              )}
            </div>
            {failure ? (
              <Notice tone="critical" role="alert">
                {failure}
              </Notice>
            ) : null}
            <Toolbar align="end">
              <Button onClick={onClose}>Cancel</Button>
              <Button type="submit" variant="accent">
                Save secret
              </Button>
            </Toolbar>
          </fieldset>
        </form>
      )}
    </Sheet>
  );
}

/** Replace the value — the only way a value changes after its save; the bindings stay as they are. */
function ReplaceValueSheet({
  secret,
  onClose,
  onChanged,
}: {
  secret: SecretListingView;
  onClose: () => void;
  onChanged: () => void;
}): JSX.Element {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState<unknown>(null);
  const [scrubbed, setScrubbed] = useState<unknown>(null);
  const save = async (): Promise<void> => {
    const typed = value;
    setValue('');
    const result = await writeSecret(
      'secrets.put',
      {
        name: secret.name,
        value: typed,
        totp: secret.totp,
        // The same bindings, unchanged: replacing a value is not a rebind.
        bindings: secret.bindings.map(({ kind, target, rule }) => ({ kind, target, rule })),
      },
      setBusy,
      setFailure,
    );
    if (result !== null) {
      setSaved(result);
      onChanged();
    }
  };
  const scrub = async (): Promise<void> => {
    const result = await writeSecret('secrets.scrub_history', { name: secret.name }, setBusy, setFailure);
    if (result !== null) {
      setScrubbed(result);
      onChanged();
    }
  };
  return (
    <Sheet title={`Replace the value of “${secret.name}”`} onClose={onClose}>
      {saved ? (
        <SavedReport
          name={secret.name}
          result={saved}
          scrubbed={scrubbed}
          busy={busy}
          failure={failure}
          onScrub={() => void scrub()}
          onDone={onClose}
        />
      ) : (
        <form
          className="ui-stack"
          data-gap="sm"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <fieldset disabled={busy} className="ui-stack" data-gap="sm">
            <Field label="New value" hint="Replaces what is stored. The bindings stay as they are.">
              <input type="password" autoComplete="new-password" spellCheck={false} required autoFocus value={value} onChange={(event) => setValue(event.target.value)} />
            </Field>
            {failure ? (
              <Notice tone="critical" role="alert">
                {failure}
              </Notice>
            ) : null}
            <Toolbar align="end">
              <Button onClick={onClose}>Cancel</Button>
              <Button type="submit" variant="accent">
                Save value
              </Button>
            </Toolbar>
          </fieldset>
        </form>
      )}
    </Sheet>
  );
}

function RenameSheet({
  secret,
  onClose,
  onChanged,
}: {
  secret: SecretListingView;
  onClose: () => void;
  onChanged: () => void;
}): JSX.Element {
  const [to, setTo] = useState(secret.name);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const rename = async (): Promise<void> => {
    const result = await writeSecret('secrets.rename', { name: secret.name, to: to.trim() }, setBusy, setFailure);
    if (result !== null) {
      onChanged();
      onClose();
    }
  };
  return (
    <Sheet title={`Rename “${secret.name}”`} onClose={onClose}>
      <form
        className="ui-stack"
        data-gap="sm"
        onSubmit={(event) => {
          event.preventDefault();
          void rename();
        }}
      >
        <fieldset disabled={busy} className="ui-stack" data-gap="sm">
          <Field label="New name" hint="The vault entry never moves; only the name the agents ask for does.">
            <input required autoFocus maxLength={200} value={to} onChange={(event) => setTo(event.target.value)} />
          </Field>
          {failure ? (
            <Notice tone="critical" role="alert">
              {failure}
            </Notice>
          ) : null}
          <Toolbar align="end">
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="accent" disabled={!to.trim() || to.trim() === secret.name}>
              Save name
            </Button>
          </Toolbar>
        </fieldset>
      </form>
    </Sheet>
  );
}

/** Replace where the value may go — the owner's own action, never a tool of an agent's. */
function RebindSheet({
  secret,
  destinations,
  onClose,
  onChanged,
}: {
  secret: SecretListingView;
  destinations: SecretsView['destinations'];
  onClose: () => void;
  onChanged: () => void;
}): JSX.Element {
  const [bindings, setBindings] = useState<BindingDraft[]>(() =>
    secret.bindings.map((binding) => ({ kind: binding.kind, target: targetInputText(binding.target), rule: binding.rule })),
  );
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const rebind = async (): Promise<void> => {
    const parsed = bindings.map((binding) => parseTargetInput(binding.kind, binding.target));
    const bad = parsed.findIndex((parse) => !parse.ok);
    if (bad !== -1) {
      setFailure(`Binding ${bad + 1}: ${(parsed[bad] as { ok: false; error: string }).error}`);
      return;
    }
    const result = await writeSecret(
      'secrets.rebind',
      {
        name: secret.name,
        bindings: bindings.map((binding, index) => ({
          kind: binding.kind,
          target: (parsed[index] as { ok: true; target: unknown }).target,
          rule: binding.rule,
        })),
      },
      setBusy,
      setFailure,
    );
    if (result !== null) {
      onChanged();
      onClose();
    }
  };
  return (
    <Sheet title={`Rebind “${secret.name}”`} onClose={onClose}>
      <form
        className="ui-stack"
        data-gap="sm"
        onSubmit={(event) => {
          event.preventDefault();
          void rebind();
        }}
      >
        <fieldset disabled={busy} className="ui-stack" data-gap="sm">
          <BindingEditor destinations={destinations} bindings={bindings} disabled={busy} onChange={setBindings} />
          {bindings.length === 0 ? <p className="ui-field-hint">{UNBOUND_LINE}</p> : null}
          {destinations.length ? (
            <Toolbar>
              <Button
                size="sm"
                onClick={() =>
                  setBindings([...bindings, { kind: destinations[0]!.kind, target: '', rule: destinations[0]!.maxRule }])
                }
              >
                Add a binding
              </Button>
            </Toolbar>
          ) : null}
          {failure ? (
            <Notice tone="critical" role="alert">
              {failure}
            </Notice>
          ) : null}
          <Toolbar align="end">
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="accent">
              Save bindings
            </Button>
          </Toolbar>
        </fieldset>
      </form>
    </Sheet>
  );
}