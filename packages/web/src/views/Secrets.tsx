/**
 * Settings → Keys and secrets (docs/owner-secrets.md §6), as the kit draws it
 * (buddi-design `ui_kits/dashboard/Secrets.jsx`).
 *
 * One flush panel of groups, each a short heading over its rows, hairlines
 * between them, an empty group not drawn: Your secrets (the owner's own, that
 * agents fill through `secret.fill`), Mail (mailbox passwords), one group per
 * plugin that keeps secrets (Calendar links), Model accounts and Connections
 * — the last two read-only here, each row linking to where it is managed.
 *
 * A row is a glyph for its kind, a human name, one plain line on where it may
 * go and when it was last used; no pill when healthy. A problem is one
 * sentence in the warning ink with its one fix as the row's button, and a
 * secret nothing reaches any more says so quietly with Remove — never removed
 * by itself. The stored name, the bindings as kept and the ids sit behind the
 * row's sheet's Details. The words are `secret-rules.ts`'s, pure and tested.
 *
 * The value itself this page never shows again after a save: the add form
 * and Replace value take it once, in a password field. Every write is an
 * ownerOnly tool invoked as the owner through the act route, so no model ever
 * sees one, and a refused one answers beside the button that asked.
 */
import { useEffect, useMemo, useState } from 'react';
import { api, type SecretListingView, type SecretRule, type SecretsView } from '../api';
import { fmtRelative, fmtTime } from '../format';
import {
  ActionMenu,
  AppIcon,
  Button,
  ButtonLink,
  Details,
  Empty,
  EmptyState,
  ErrorBanner,
  Field,
  Icon,
  KV,
  List,
  ListRow,
  Modal,
  Notice,
  PageFrame,
  Panel,
  Sheet,
  Spacer,
  Stack,
  Toolbar,
  useAsync,
  type IconName,
} from '../ui';
import {
  RULE_ASKS,
  RULE_CHOICES,
  UNBOUND_LINE,
  allowedRules,
  defaultRule,
  deleteStops,
  foundSentence,
  groupHeading,
  groupOrder,
  historyWords,
  isManagedElsewhere,
  kindWords,
  lastUsedLine,
  managedHref,
  mailboxPasswordHref,
  parseTargetInput,
  placeExample,
  renderTarget,
  scrubbedSentence,
  secretGroup,
  secretProblem,
  secretTag,
  secretTitle,
  targetInputText,
  targetPlaceholder,
  unusedLine,
  uncheckedLine,
  offersRemove,
  whereLine,
  type AccountName,
  type SecretFix,
  type SecretGroupId,
} from './secret-rules';
import { providerName } from './Providers';
import { settingsRoute } from '../routes';

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

/** What is open over the page: one secret's sheet or one of its forms, or the add form. */
type Open =
  | { what: 'sheet' | 'replace' | 'rename' | 'places' | 'delete'; name: string }
  | { what: 'add' }
  | null;

/** The page's one line under its title, shared with the Settings header that draws it. */
export const SECRETS_LEDE = 'Passwords, keys and links your agents use without ever seeing them. Each goes only where you allow.';

/** A row's glyph: what kind of thing holds it, else where it goes. */
function glyphFor(secret: SecretListingView, group: SecretGroupId): IconName {
  if (group === 'mail') return 'mail';
  if (group === 'models') return 'chip';
  if (group === 'connections') return 'plug';
  if (group === 'plugin:calendar') return 'calendar';
  const kinds = secret.bindings.map((b) => b.kind);
  if (kinds.some((k) => k.startsWith('browser.'))) return 'globe';
  if (kinds.includes('developer.env')) return 'terminal';
  return 'key';
}

/**
 * `secret` is the name a link asked for (`#/settings/secrets?secret=<name>`):
 * that secret's Replace value opens, the way a restored secret gets its value
 * back. `adding` is `?add=1`, the header's Add a secret; `navigate` takes the
 * page back to its plain address when either closes.
 */
export function Secrets({
  embedded,
  timezone,
  secret: linked,
  adding,
  navigate,
}: {
  embedded?: boolean;
  timezone?: string;
  secret?: string | null;
  adding?: boolean;
  navigate?: (route: string) => void;
} = {}): JSX.Element {
  const view = useAsync(() => api.secrets(), []);
  // A model account's label and provider name its row; the gateway names the account, the page its provider.
  const providerAccounts = useAsync(() => api.providerAccounts(), []);
  const accounts = useMemo(
    () => new Map<string, AccountName>((providerAccounts.data?.accounts ?? []).map((a) => [a.id, { label: a.label, provider: providerName(a) }])),
    [providerAccounts.data],
  );
  const [open, setOpen] = useState<Open>(linked ? { what: 'replace', name: linked } : adding ? { what: 'add' } : null);
  useEffect(() => { if (linked) setOpen({ what: 'replace', name: linked }); }, [linked]);
  useEffect(() => { if (adding) setOpen({ what: 'add' }); }, [adding]);
  const close = (): void => {
    setOpen(null);
    if ((linked || adding) && navigate) navigate(settingsRoute('secrets'));
  };
  const data: SecretsView | undefined = view.data;
  const groups = useMemo(() => {
    const by = new Map<SecretGroupId, SecretListingView[]>();
    for (const secret of data?.secrets ?? []) {
      const group = secretGroup(secret);
      by.set(group, [...(by.get(group) ?? []), secret]);
    }
    return [...by.entries()].sort(([a], [b]) => groupOrder(a, b));
  }, [data]);
  const current = open && open.what !== 'add' ? data?.secrets.find((s) => s.name === open.name) ?? null : null;
  return (
    <PageFrame
      embedded={embedded}
      title="Keys and secrets"
      lede={SECRETS_LEDE}
      actions={embedded ? undefined : <Button variant="accent" size="sm" onClick={() => setOpen({ what: 'add' })}>Add a secret</Button>}
    >
      <Stack gap="lg">
        {!data && !view.error ? <Empty>Opening the vault…</Empty> : null}
        {view.error ? (
          <Stack gap="sm">
            <ErrorBanner message={view.error} />
            <Toolbar>
              <Button onClick={view.reload}>Retry</Button>
            </Toolbar>
          </Stack>
        ) : null}
        {data && data.secrets.length === 0 ? (
          <Panel>
            <EmptyState icon="lock" title="Nothing stored yet.">
              Add a site password or an API token, and say where an agent may use it. Mailbox passwords and calendar links show up here as you add them.
            </EmptyState>
          </Panel>
        ) : null}
        {data && data.secrets.length > 0 ? (
          <Panel flush>
            {groups.map(([group, secrets]) => {
              const heading = groupHeading(group);
              return (
                <section key={group} className="secrets-group" aria-label={heading.title}>
                  <header className="secrets-group-head">
                    <h3 className="secrets-group-title">{heading.title}</h3>
                    <span className="secrets-group-aside">{heading.aside}</span>
                  </header>
                  <List>
                    {secrets.map((secret) => (
                      <SecretRow
                        key={secret.name}
                        secret={secret}
                        group={group}
                        accounts={accounts}
                        onOpen={(what) => setOpen({ what, name: secret.name })}
                      />
                    ))}
                  </List>
                </section>
              );
            })}
          </Panel>
        ) : null}
        {data && data.ownKeys.length > 0 ? (
          <Details summary={`buddi’s own keys · ${data.ownKeys.length}`}>
            <p className="secrets-note">
              The keys buddi itself runs on, read from its environment:{' '}
              {data.ownKeys.map((key, index) => (
                <span key={key}>
                  {index > 0 ? ', ' : ''}
                  <code className="mono">{key}</code>
                </span>
              ))}
              . They aren’t changed here, and buddi hides them in whatever it sends out, like your own.
            </p>
          </Details>
        ) : null}
      </Stack>
      {open?.what === 'add' && data ? <AddSecretSheet destinations={data.destinations} onClose={close} onChanged={view.reload} /> : null}
      {current && open?.what === 'sheet' ? (
        <SecretSheet
          secret={current}
          accounts={accounts}
          timezone={timezone}
          onClose={close}
          onOpen={(what) => setOpen({ what, name: current.name })}
        />
      ) : null}
      {current && open?.what === 'replace' ? (
        <ReplaceValueModal secret={current} title={secretTitle(current, accounts)} onClose={close} onChanged={view.reload} />
      ) : null}
      {current && open?.what === 'rename' ? <RenameModal secret={current} onClose={close} onChanged={view.reload} /> : null}
      {current && open?.what === 'places' && data ? (
        <PlacesSheet secret={current} title={secretTitle(current, accounts)} destinations={data.destinations} onClose={close} onChanged={view.reload} />
      ) : null}
      {current && open?.what === 'delete' ? (
        <DeleteModal secret={current} title={secretTitle(current, accounts)} onClose={close} onChanged={view.reload} />
      ) : null}
    </PageFrame>
  );
}

/** Stop a click inside a row's side from opening the row's sheet. */
const stop = (run?: () => void) => (event: { stopPropagation: () => void }): void => {
  event.stopPropagation();
  run?.();
};

/** A problem's fix, as the row's one button: a form here, or a link to where it is fixed. */
function FixButton({ fix, onOpen }: { fix: SecretFix; onOpen: (what: 'replace' | 'places') => void }): JSX.Element {
  if ('href' in fix) {
    return (
      <ButtonLink size="sm" href={fix.href} onClick={stop()}>
        {fix.label}
      </ButtonLink>
    );
  }
  return (
    <Button size="sm" onClick={stop(() => onOpen(fix.action))}>
      {fix.label}
    </Button>
  );
}

/** The ⋯ menu of a row the owner changes here: what it is about first, what takes it away last. */
function rowMenu(secret: SecretListingView, group: SecretGroupId, onOpen: (what: 'sheet' | 'replace' | 'rename' | 'places' | 'delete') => void) {
  if (group === 'mine') {
    return [
      { label: 'Replace value…', onSelect: () => onOpen('replace') },
      { label: 'Rename…', onSelect: () => onOpen('rename') },
      { label: 'Change where it may go…', hint: 'Places, and when it asks', onSelect: () => onOpen('places') },
      { label: 'Usage history', onSelect: () => onOpen('sheet') },
      'separator' as const,
      { label: 'Delete…', tone: 'critical' as const, onSelect: () => onOpen('delete') },
    ];
  }
  if (group === 'mail') {
    const mailbox = (secret.usedBy ?? []).find((u) => u.kind === 'mailbox');
    return [
      mailbox && !secret.unused
        ? { label: 'Set a new password', hint: 'On the Email page, which tests it first', onSelect: () => { window.location.hash = mailboxPasswordHref(mailbox.id); } }
        : null,
      { label: 'Usage history', onSelect: () => onOpen('sheet') },
      offersRemove(secret) ? ('separator' as const) : null,
      offersRemove(secret) ? { label: 'Remove…', tone: 'critical' as const, onSelect: () => onOpen('delete') } : null,
    ];
  }
  // A plugin's: its value may change here; its name and places are the plugin's to keep.
  return [
    { label: group === 'plugin:calendar' ? 'Replace link…' : 'Replace value…', onSelect: () => onOpen('replace') },
    { label: 'Usage history', onSelect: () => onOpen('sheet') },
    offersRemove(secret) ? ('separator' as const) : null,
    offersRemove(secret) ? { label: 'Remove…', tone: 'critical' as const, onSelect: () => onOpen('delete') } : null,
  ];
}

/** One secret: its glyph, its human name, where it may go, its last use, and what is wrong with it if anything is. */
function SecretRow({
  secret,
  group,
  accounts,
  onOpen,
}: {
  secret: SecretListingView;
  group: SecretGroupId;
  accounts: ReadonlyMap<string, AccountName>;
  onOpen: (what: 'sheet' | 'replace' | 'rename' | 'places' | 'delete') => void;
}): JSX.Element {
  const title = secretTitle(secret, accounts);
  const tag = secretTag(secret, accounts);
  const line = [whereLine(secret), lastUsedLine(secret)].filter(Boolean).join(' · ');
  const problem = secretProblem(secret);
  const unused = unusedLine(secret);
  const unchecked = uncheckedLine(secret);
  const managed = isManagedElsewhere(group) ? managedHref(secret) : null;
  return (
    <ListRow
      onClick={() => onOpen('sheet')}
      label={`${title}: details`}
      lead={<AppIcon icon={glyphFor(secret, group)} />}
      title={
        <>
          {title}
          {tag ? <span className="secrets-tag">{tag}</span> : null}
        </>
      }
      sub={
        <>
          <span className="secrets-line">{line}</span>
          {problem ? (
            <span className="secrets-status" data-tone="warning">
              {problem.text}
            </span>
          ) : null}
          {unused ? <span className="secrets-status">{unused}</span> : null}
          {unchecked ? <span className="secrets-status">{unchecked}</span> : null}
        </>
      }
      side={
        <span className="secrets-side">
          {problem?.fix ? <FixButton fix={problem.fix} onOpen={onOpen} /> : null}
          {unused && offersRemove(secret) ? (
            <Button size="sm" variant="ghost" onClick={stop(() => onOpen('delete'))}>
              Remove…
            </Button>
          ) : null}
          {managed ? (
            <a className="secrets-managed" href={managed.href} onClick={stop()}>
              {managed.label}
              <Icon name="chevron-right" size={12} />
            </a>
          ) : (
            <ActionMenu label={`More for ${title}`} items={rowMenu(secret, group, onOpen)} sheet={{ title, sub: line }} />
          )}
        </span>
      }
    />
  );
}

/** The row's sheet: where it may go and when it asks, the problem and its fix, the history in words, the internals folded. */
function SecretSheet({
  secret,
  accounts,
  timezone,
  onClose,
  onOpen,
}: {
  secret: SecretListingView;
  accounts: ReadonlyMap<string, AccountName>;
  timezone?: string;
  onClose: () => void;
  onOpen: (what: 'replace' | 'rename' | 'places' | 'delete') => void;
}): JSX.Element {
  const group = secretGroup(secret);
  const title = secretTitle(secret, accounts);
  const problem = secretProblem(secret);
  const unused = unusedLine(secret);
  const rules = [...new Set(secret.bindings.map((b) => b.rule))];
  const last = secret.lastUse;
  const ids = (secret.usedBy ?? []).map((user) => ({
    label: user.kind === 'mailbox' ? 'Mailbox' : user.kind === 'model-account' ? 'Model account' : 'Connection',
    value: <code className="mono secrets-mono">{user.id}</code>,
  }));
  return (
    <Sheet
      title={title}
      onClose={onClose}
      foot={
        group === 'mine' ? (
          <Toolbar>
            <Button variant="danger-ghost" onClick={() => onOpen('delete')}>
              Delete…
            </Button>
            <Spacer />
            <Button onClick={() => onOpen('rename')}>Rename…</Button>
            <Button variant="accent" onClick={() => onOpen('replace')}>
              Replace value…
            </Button>
          </Toolbar>
        ) : undefined
      }
    >
      <Stack gap="lg">
        <KV
          items={[
            { label: 'Where it may go', value: whereLine(secret) || 'Nowhere yet' },
            // When it asks is the owner's own choice only for their own secrets; a mailbox's or a plugin's is set where it was added.
            ...(rules.length === 1 && group === 'mine' ? [{ label: 'Asks you', value: RULE_ASKS[rules[0]!] }] : []),
            { label: 'Last used', value: last ? `${fmtRelative(last.at)}${last.agentId ? ` by ${last.agentId}` : ''}` : 'Never' },
          ]}
        />
        {problem ? (
          <Notice tone="warning" action={problem.fix ? <FixButton fix={problem.fix} onOpen={onOpen} /> : undefined}>
            {problem.text}
          </Notice>
        ) : null}
        {unused ? (
          offersRemove(secret) ? (
            <Notice action={<Button size="sm" onClick={() => onOpen('delete')}>Remove…</Button>}>{unused} Nothing removes it but you.</Notice>
          ) : (
            <Notice>{unused}</Notice>
          )
        ) : null}
        {uncheckedLine(secret) ? <Notice>{uncheckedLine(secret)}</Notice> : null}
        <Stack gap="sm">
          <h3 className="secrets-sheet-head">Usage history</h3>
          <UseLog name={secret.name} timezone={timezone} />
        </Stack>
        <Details summary="Details">
          <Stack gap="sm">
            <KV
              items={[
                { label: 'Stored as', value: <code className="mono secrets-mono">{secret.name}</code> },
                ...secret.bindings.map((binding, index) => ({
                  key: `b${index}`,
                  label: index === 0 ? 'Bindings' : '',
                  value: (
                    <code className="mono secrets-mono">
                      {binding.kind} {renderTarget(binding.kind, binding.target)} · {binding.rule}
                    </code>
                  ),
                })),
                ...(secret.totp ? [{ label: 'One-time code', value: 'buddi fills the current code, never the seed' }] : []),
                ...ids,
              ]}
            />
            <p className="secrets-note">
              What buddi keeps for it, never the value. “Held back” means buddi declined to hand the value over — not bound to
              that place, no value stored, or the vault locked — so it never left.
            </p>
          </Stack>
        </Details>
      </Stack>
    </Sheet>
  );
}

/** One secret's use log, asked for when its sheet opens, newest first, in words. */
function UseLog({ name, timezone }: { name: string; timezone?: string }): JSX.Element {
  const log = useAsync(() => api.secretUses(name, 50), [name]);
  if (log.error) return <ErrorBanner message={log.error} />;
  if (!log.data) return <Empty>Reading the history…</Empty>;
  const uses = log.data.uses;
  if (uses.length === 0) return <p className="secrets-note">Nothing has used it yet.</p>;
  return (
    <List>
      {uses.map((use, index) => {
        const words = historyWords(use);
        return (
          <ListRow
            key={index}
            title={
              <span className="secrets-history" data-tone={words.tone}>
                {words.text}
              </span>
            }
            sub={`${fmtTime(use.at, timezone ?? 'UTC')} · ${use.agent ?? (use.plugin ? `the ${use.plugin} plugin` : 'you')}`}
          />
        );
      })}
    </List>
  );
}

/**
 * What a save came back with: the value is not coming back, but where it
 * already sits is (§6) — one line, and the one tap that scrubs it.
 */
function SavedReport({
  title,
  result,
  scrubbed,
  busy,
  failure,
  onScrub,
}: {
  title: string;
  result: unknown;
  scrubbed: unknown;
  busy: boolean;
  failure: string | null;
  onScrub: () => void;
}): JSX.Element {
  const found = foundSentence(result);
  return (
    <Stack gap="sm">
      <Notice tone="good" role="status">
        Saved “{title}”. Its value is never shown again.
      </Notice>
      <p className="secrets-note">{found || 'Nothing of the value sits where buddi already holds text.'}</p>
      <ErrorBanner message={failure} />
      {found ? (
        <Toolbar>
          <Button variant="accent" disabled={busy || scrubbed !== null} onClick={onScrub}>
            {scrubbed === null ? 'Scrub the history' : scrubbedSentence(scrubbed) || 'Nothing of it was left to replace.'}
          </Button>
        </Toolbar>
      ) : null}
    </Stack>
  );
}

/** The places one form is editing: what kind of place, the place, and when it asks — one row each. */
function PlacesEditor({
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
        const kinds = destination ? destinations : [...destinations, { kind: binding.kind, plugin: '', maxRule: binding.rule }];
        return (
          <div key={index} className="secrets-place">
            <Field label="Kind of place">
              <select
                value={binding.kind}
                disabled={disabled}
                onChange={(event) => {
                  const kind = event.target.value;
                  const max = destinations.find((d) => d.kind === kind)?.maxRule;
                  change(index, { kind, rule: max ? defaultRule(max) : binding.rule });
                }}
              >
                {kinds.map((d) => (
                  <option key={d.kind} value={d.kind}>
                    {kindWords(d.kind)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="The place">
              <input
                type="text"
                spellCheck={false}
                disabled={disabled}
                value={binding.target}
                placeholder={placeExample(binding.kind)}
                onChange={(event) => change(index, { target: event.target.value })}
              />
            </Field>
            <Field label="Asks you">
              <select value={binding.rule} disabled={disabled} onChange={(event) => change(index, { rule: event.target.value as SecretRule })}>
                {allowedRules(loosest).map((rule) => (
                  <option key={rule} value={rule}>
                    {RULE_CHOICES[rule]}
                  </option>
                ))}
              </select>
            </Field>
            <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onChange(bindings.filter((_, at) => at !== index))}>
              Remove
            </Button>
            <p className="ui-field-hint secrets-place-hint">The place: {targetPlaceholder(binding.kind)}.</p>
          </div>
        );
      })}
      {bindings.length === 0 ? <p className="ui-field-hint">{UNBOUND_LINE}</p> : null}
      {destinations.length ? (
        <Toolbar>
          <Button size="sm" disabled={disabled} onClick={() => onChange([...bindings, { kind: destinations[0]!.kind, target: '', rule: defaultRule(destinations[0]!.maxRule) }])}>
            Add a place
          </Button>
        </Toolbar>
      ) : (
        <p className="ui-field-hint">Nothing installed here takes a secret yet, so there is nowhere to send one.</p>
      )}
    </Stack>
  );
}

/** The places as the tools take them, or the first one's mistake in words. */
function parsePlaces(bindings: BindingDraft[]): { ok: true; bindings: Array<{ kind: string; target: unknown; rule: SecretRule }> } | { ok: false; error: string } {
  const parsed = bindings.map((binding) => parseTargetInput(binding.kind, binding.target));
  const bad = parsed.findIndex((parse) => !parse.ok);
  if (bad !== -1) return { ok: false, error: `Place ${bad + 1}: ${(parsed[bad] as { ok: false; error: string }).error}` };
  return {
    ok: true,
    bindings: bindings.map((binding, index) => ({ kind: binding.kind, target: (parsed[index] as { ok: true; target: unknown }).target, rule: binding.rule })),
  };
}

/** The add form: the one place the owner types a new value, which this page never shows again. */
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
    destinations.length ? [{ kind: destinations[0]!.kind, target: '', rule: defaultRule(destinations[0]!.maxRule) }] : [],
  );
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ name: string; result: unknown } | null>(null);
  const [scrubbed, setScrubbed] = useState<unknown>(null);
  const save = async (): Promise<void> => {
    const places = parsePlaces(bindings);
    if (!places.ok) {
      setFailure(places.error);
      return;
    }
    const typed = value;
    setValue('');
    const result = await writeSecret('secrets.put', { name: name.trim(), value: typed, totp, bindings: places.bindings }, setBusy, setFailure);
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
  if (saved) {
    return (
      <Sheet title="Add a secret" onClose={onClose} foot={<Toolbar align="end"><Button onClick={onClose}>Done</Button></Toolbar>}>
        <SavedReport title={saved.name} result={saved.result} scrubbed={scrubbed} busy={busy} failure={failure} onScrub={() => void scrub()} />
      </Sheet>
    );
  }
  return (
    <Sheet
      title="Add a secret"
      size="wide"
      onClose={onClose}
      foot={
        <Toolbar align="end">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form="secrets-add" variant="accent" disabled={busy}>
            Save secret
          </Button>
        </Toolbar>
      }
    >
      <form
        id="secrets-add"
        className="ui-stack"
        data-gap="lg"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <fieldset disabled={busy} className="ui-stack" data-gap="sm">
          <Field label="Name" hint="What agents ask for it by. Saving a name that exists replaces that secret’s value.">
            <input required autoFocus maxLength={200} value={name} onChange={(event) => setName(event.target.value)} placeholder="PNC password" />
          </Field>
          <Field label="Value" hint="Kept in the vault and never shown again, not even here.">
            <input type="password" autoComplete="new-password" spellCheck={false} required value={value} onChange={(event) => setValue(event.target.value)} />
          </Field>
          <label className="backup-check">
            <input type="checkbox" checked={totp} onChange={(event) => setTotp(event.target.checked)} />
            <span>It’s a one-time-code seed — buddi fills the current code, never the seed</span>
          </label>
        </fieldset>
        <fieldset disabled={busy} className="ui-stack" data-gap="sm">
          <h3 className="secrets-sheet-head">Where it may go</h3>
          <p className="secrets-note">Agents can use it only in these places. Anywhere else, buddi holds it back and the row says so.</p>
          <PlacesEditor destinations={destinations} bindings={bindings} disabled={busy} onChange={setBindings} />
        </fieldset>
        {failure ? (
          <Notice tone="critical" role="alert">
            {failure}
          </Notice>
        ) : null}
      </form>
    </Sheet>
  );
}

/** Replace the value — the only way a value changes after its save; where it may go stays as it is. */
function ReplaceValueModal({
  secret,
  title,
  onClose,
  onChanged,
}: {
  secret: SecretListingView;
  title: string;
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
  if (saved) {
    return (
      <Modal title={`Replaced the value of “${title}”`} onClose={onClose} foot={<Button variant="accent" onClick={onClose}>Done</Button>}>
        <SavedReport title={title} result={saved} scrubbed={scrubbed} busy={busy} failure={failure} onScrub={() => void scrub()} />
      </Modal>
    );
  }
  return (
    <Modal
      title={`Replace the value of “${title}”`}
      onClose={onClose}
      foot={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="secrets-replace" variant="accent" disabled={busy || value === ''}>
            Save value
          </Button>
        </>
      }
    >
      <form
        id="secrets-replace"
        className="ui-stack"
        data-gap="sm"
        onSubmit={(event) => {
          event.preventDefault();
          if (value !== '') void save();
        }}
      >
        <Field label="New value" hint="Kept in the vault and never shown again. Where it may go stays the same.">
          <input type="password" autoComplete="new-password" spellCheck={false} required autoFocus disabled={busy} value={value} onChange={(event) => setValue(event.target.value)} />
        </Field>
        <ErrorBanner message={failure} />
      </form>
    </Modal>
  );
}

function RenameModal({ secret, onClose, onChanged }: { secret: SecretListingView; onClose: () => void; onChanged: () => void }): JSX.Element {
  const [to, setTo] = useState(secret.name);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const ready = to.trim() !== '' && to.trim() !== secret.name;
  const rename = async (): Promise<void> => {
    const result = await writeSecret('secrets.rename', { name: secret.name, to: to.trim() }, setBusy, setFailure);
    if (result !== null) {
      onChanged();
      onClose();
    }
  };
  return (
    <Modal
      title={`Rename “${secret.name}”`}
      onClose={onClose}
      foot={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="secrets-rename" variant="accent" disabled={busy || !ready}>
            Rename
          </Button>
        </>
      }
    >
      <form
        id="secrets-rename"
        className="ui-stack"
        data-gap="sm"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) void rename();
        }}
      >
        <Field label="Name" hint="What agents ask for it by. One that uses the old name needs the new one.">
          <input required autoFocus maxLength={200} disabled={busy} value={to} onChange={(event) => setTo(event.target.value)} />
        </Field>
        <ErrorBanner message={failure} />
      </form>
    </Modal>
  );
}

/** Where the value may go — the owner's own action, never a tool of an agent's. */
function PlacesSheet({
  secret,
  title,
  destinations,
  onClose,
  onChanged,
}: {
  secret: SecretListingView;
  title: string;
  destinations: SecretsView['destinations'];
  onClose: () => void;
  onChanged: () => void;
}): JSX.Element {
  const [bindings, setBindings] = useState<BindingDraft[]>(() =>
    secret.bindings.length
      ? secret.bindings.map((binding) => ({ kind: binding.kind, target: targetInputText(binding.target), rule: binding.rule }))
      : destinations.length
        ? [{ kind: destinations[0]!.kind, target: '', rule: defaultRule(destinations[0]!.maxRule) }]
        : [],
  );
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const save = async (): Promise<void> => {
    const places = parsePlaces(bindings);
    if (!places.ok) {
      setFailure(places.error);
      return;
    }
    const result = await writeSecret('secrets.rebind', { name: secret.name, bindings: places.bindings }, setBusy, setFailure);
    if (result !== null) {
      onChanged();
      onClose();
    }
  };
  return (
    <Sheet
      title={`Where “${title}” may go`}
      size="wide"
      onClose={onClose}
      foot={
        <Toolbar align="end">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form="secrets-places" variant="accent" disabled={busy}>
            Save
          </Button>
        </Toolbar>
      }
    >
      <form
        id="secrets-places"
        className="ui-stack"
        data-gap="sm"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <p className="secrets-note">Agents can use it only in these places. Anywhere else, buddi holds it back and the row says so.</p>
        <PlacesEditor destinations={destinations} bindings={bindings} disabled={busy} onChange={setBindings} />
        {failure ? (
          <Notice tone="critical" role="alert">
            {failure}
          </Notice>
        ) : null}
      </form>
    </Sheet>
  );
}

/** Delete asks once, naming what stops working; the usage history stays. */
function DeleteModal({ secret, title, onClose, onChanged }: { secret: SecretListingView; title: string; onClose: () => void; onChanged: () => void }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const removing = Boolean(secret.unused);
  const del = async (): Promise<void> => {
    const result = await writeSecret('secrets.delete', { name: secret.name }, setBusy, setFailure);
    if (result !== null) {
      onChanged();
      onClose();
    }
  };
  return (
    <Modal
      title={`${removing ? 'Remove' : 'Delete'} “${title}”?`}
      onClose={onClose}
      foot={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" disabled={busy} onClick={() => void del()}>
            {removing ? 'Remove' : 'Delete'}
          </Button>
        </>
      }
    >
      <p className="secrets-dialog-text">{deleteStops(secret)} The value is gone for good; its usage history stays, under its name.</p>
      <ErrorBanner message={failure} />
    </Modal>
  );
}
