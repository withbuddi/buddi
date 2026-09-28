/**
 * "Add a teammate": the starter team, and the plugin agents beside it.
 *
 * Day one holds a front desk and a maker, and nothing on the page shows what
 * another agent would add. These cards do: each one is a ready-made agent —
 * Scout, Planner, Keeper, and Mail Triage, Ledger, Illustrator when their
 * plugin is there — added with one tap through the same accept every agent
 * offer uses (`useAcceptPluginAgent`), so the owner's click is the maker's
 * approval. A plugin agent whose plugin or requirement is missing is drawn
 * greyed with the reason and the page that fixes it. A dismissed card is gone
 * for good, through the same dismiss route Home's offers use.
 */
import { useState } from 'react';
import { api, type TeammateRow } from '../../api';
import type { ChatAgent } from '../../chat/types';
import { agentRoute, pluginSettingsRoute, settingsRoute } from '../../routes';
import { ROLE_MAKER } from '../../shell/roster';
import { Button, Card, ErrorBanner, Section, Spacer, Toolbar, useAsync } from '../../ui';
import { Icon } from '../../ui/Icon';
import { useAcceptPluginAgent, type AcceptedAgent } from './AgentOffer';

export const ADD_TEAMMATE_TITLE = 'Add a teammate';
export const ADD_TEAMMATE_LEDE =
  'Each one keeps its own memory and tools, and can work on a schedule. Add the ones you want; Agent Father can make others.';

const ROLE_FRONT_DESK = 'front-desk';

/**
 * Whether the team is still day one: nobody but the front desk and the maker.
 * Home shows the cards only then; the Agents page always shows them.
 */
export function onlyDeskAndMaker(agents: readonly ChatAgent[], defaultAgentId: string | null | undefined): boolean {
  return (
    agents.length > 0 &&
    agents.every((a) => a.id === defaultAgentId || a.roles.includes(ROLE_FRONT_DESK) || a.roles.includes(ROLE_MAKER))
  );
}

const FIX: Record<NonNullable<TeammateRow['fix']>, { label: string; route: string }> = {
  plugins: { label: 'Plugins', route: settingsRoute('plugins') },
  mailbox: { label: 'Add a mailbox', route: pluginSettingsRoute('email', 'settings') },
  accounts: { label: 'Accounts', route: settingsRoute('accounts') },
};

export const ADD_TEAMMATE_COMPLETE = 'Your starter team is complete. Agent Father can make others.';

/**
 * The section: title, the one line, and a card per teammate. Nothing when
 * every card is dismissed.
 *
 * `standing` is the Agents page, where the section is always there under the
 * team: the cards still to add come first, the ones already added close it as
 * compact "Added · open @handle" chips, and when nothing is left to add the
 * section says the starter team is complete. Home's day one draws every card.
 */
export function AddTeammate({ navigate, standing = false }: { navigate: (route: string) => void; standing?: boolean }): JSX.Element | null {
  const read = useAsync(() => api.teammates(), []);
  const [gone, setGone] = useState<Set<string>>(new Set());
  const rows = (read.data?.teammates ?? []).filter((row) => !gone.has(`${row.plugin}/${row.agent}`));
  if (rows.length === 0) return null;
  const dismiss = (row: TeammateRow): void => {
    setGone((current) => new Set(current).add(`${row.plugin}/${row.agent}`));
    void api.dismissAgentOffer(row.plugin, row.agent).then(read.reload, read.reload);
  };
  const go = (route: string) => (e: { preventDefault: () => void }): void => { e.preventDefault(); navigate(route); };
  const toAdd = standing ? rows.filter((row) => row.state !== 'added') : rows;
  const added = standing ? rows.filter((row) => row.state === 'added') : [];
  return (
    <Section title={ADD_TEAMMATE_TITLE}>
      {toAdd.length === 0 ? (
        <p className="teammates-lede" data-testid="teammates-complete">{ADD_TEAMMATE_COMPLETE}</p>
      ) : (
        <>
          <p className="teammates-lede">{ADD_TEAMMATE_LEDE}</p>
          <div className="teammates-grid" data-testid="teammates">
            {toAdd.map((row) => (
              <TeammateCard key={`${row.plugin}/${row.agent}`} row={row} navigate={navigate} onDismiss={() => dismiss(row)} />
            ))}
          </div>
          {added.length > 0 ? (
            <ul className="teammates-added" data-testid="teammates-added">
              {added.map((row) => (
                <li key={`${row.plugin}/${row.agent}`}>
                  <a className="teammates-added-chip" href={agentRoute(row.agent)} onClick={go(agentRoute(row.agent))}>
                    Added · open @{row.handle}
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </Section>
  );
}

function TeammateCard({
  row,
  navigate,
  onDismiss,
}: {
  row: TeammateRow;
  navigate: (route: string) => void;
  onDismiss: () => void;
}): JSX.Element {
  const offer = useAcceptPluginAgent(row.plugin, row.agent);
  const go = (route: string) => (e: { preventDefault: () => void }): void => { e.preventDefault(); navigate(route); };
  const added: AcceptedAgent | null =
    offer.created ?? (row.state === 'added' ? { id: row.agent, handle: row.handle, name: row.name } : null);
  const state = added ? 'added' : row.state;
  const fix = row.fix ? FIX[row.fix] : null;
  return (
    <div className="teammate" data-state={state} data-testid={`teammate-${row.agent}`}>
      <Card
        title={row.name}
        actions={
          <button type="button" className="ui-icon-btn" data-size="sm" aria-label={`Dismiss ${row.name}`} title="Not now" onClick={onDismiss}>
            <Icon name="close" />
          </button>
        }
        foot={
          <>
            <Toolbar>
              {state === 'unavailable' ? <span className="teammate-reason">{row.reason}</span> : null}
              <Spacer />
              {added ? (
                <a href={agentRoute(added.id)} onClick={go(agentRoute(added.id))}>Added, open @{added.handle}</a>
              ) : state === 'unavailable' ? (
                fix ? <a href={fix.route} onClick={go(fix.route)}>{fix.label}</a> : null
              ) : (
                <Button variant="accent" size="sm" disabled={offer.busy} onClick={offer.accept} aria-label={`Add ${row.name}`}>
                  Add
                </Button>
              )}
            </Toolbar>
            <ErrorBanner message={offer.failure} />
          </>
        }
      >
        <p className="ui-card-meta">{row.text}</p>
        <p className="teammate-needs">{row.needs}</p>
      </Card>
    </div>
  );
}
