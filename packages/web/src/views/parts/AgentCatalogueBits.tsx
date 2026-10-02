/**
 * What an agent's page says about the catalogue (agent-catalogue.md §6, §8):
 * one line under its name when it came from the catalogue ("From the
 * catalogue · Chef 1.0.0", with Update when there is one), and Remove from
 * team at the foot of Setup, which shows what removing does before it does it.
 */
import { useState } from 'react';
import { api, AGENTS_CHANGED, ApiError, type AgentCatalogueProvenance, type AgentRemovePreview, type CatalogueAgent } from '../../api';
import { AGENTS_ROUTE, catalogueRoute, settingsRoute } from '../../routes';
import { Button, ErrorBanner, Modal, Panel, Toolbar, useAsync } from '../../ui';
import { UpdateSheet } from './CatalogueSheets';
import { and, pluginTitle, shortVersion } from './catalogue-words';

/** Where an agent from the catalogue stands, from `GET /api/agents`: no catalogue fetch. */
export type AgentFromCatalogue = AgentCatalogueProvenance & { agentId: string };

/** The package an agent came from, when it came from the catalogue. */
export function useCatalogueEntryFor(agentId: string): { entry: AgentFromCatalogue | undefined; reload: () => void } {
  const read = useAsync(() => api.agents(), [agentId]);
  const found = read.data?.catalogue?.[agentId];
  return { entry: found ? { ...found, agentId } : undefined, reload: read.reload };
}

/**
 * "From the catalogue · Chef 1.0.0", and Update or See what changed when a
 * newer version is out; "No longer in the catalogue" when it was delisted. The
 * listing is fetched only when the owner opens the update sheet.
 */
export function CatalogueLine({ entry, navigate, onUpdated }: { entry: AgentFromCatalogue; navigate: (route: string) => void; onUpdated: () => void }): JSX.Element {
  const [listing, setListing] = useState<CatalogueAgent | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const offered = entry.delisted ? null : entry.drift === 'update' ? 'update' : entry.drift === 'edited-update' ? 'edited' : null;
  const open = (): void => {
    setOpening(true);
    setFailure(null);
    api
      .catalogue()
      .then((view) => {
        const found = view.agents.find((a) => a.name === entry.package);
        if (found) setListing(found);
        else setFailure(view.unavailable ?? `The catalogue no longer lists ${entry.title}.`);
      })
      .catch((err: unknown) => setFailure(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setOpening(false));
  };
  return (
    <>
    <p className="agent-catalogue-line" data-testid="agent-catalogue-line" data-delisted={entry.delisted ? 'true' : undefined}>
      {entry.delisted ? (
        <span>No longer in the catalogue</span>
      ) : (
        <a href={catalogueRoute(entry.package)} onClick={(e) => { e.preventDefault(); navigate(catalogueRoute(entry.package)); }}>From the catalogue</a>
      )}
      <span aria-hidden="true"> · </span>
      <span>{entry.title} {entry.via ? `(was ${entry.via.split('/')[1] ?? entry.via})` : shortVersion(entry.version)}</span>
      {entry.delisted ? <span className="muted"> · it keeps working; no updates will come</span> : null}
      {offered ? (
        <Button size="sm" variant={offered === 'update' ? 'accent' : undefined} disabled={opening} onClick={open}>
          {offered === 'update' && entry.latest ? `Update to ${shortVersion(entry.latest)}` : offered === 'update' ? 'Update' : 'See what changed'}
        </Button>
      ) : null}
    </p>
    {failure ? <ErrorBanner message={failure} /> : null}
    {listing ? <UpdateSheet entry={listing} agentId={entry.agentId} onClose={() => setListing(null)} onUpdated={onUpdated} /> : null}
    </>
  );
}

function missionWords(m: AgentRemovePreview['pausesMissions'][number]): string {
  return typeof m === 'string' ? m : m.name ?? m.id ?? 'a mission';
}

/**
 * Remove from team: asks once, with what it does — the folder to the trash,
 * its missions paused, the plugins nobody else uses named — and the click is
 * the approval.
 */
export function RemoveFromTeam({ agentId, name, navigate }: { agentId: string; name: string; navigate: (route: string) => void }): JSX.Element {
  const [asking, setAsking] = useState(false);
  const [preview, setPreview] = useState<AgentRemovePreview | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const errorText = (err: unknown): string => (err instanceof ApiError ? err.message : String(err));
  const ask = (): void => {
    setAsking(true);
    setFailure(null);
    setPreview(null);
    api.agentRemovePreview(agentId).then(setPreview).catch((err: unknown) => setFailure(errorText(err)));
  };
  const remove = (): void => {
    setBusy(true);
    setFailure(null);
    api
      .removeAgent(agentId)
      .then(() => {
        window.dispatchEvent(new Event(AGENTS_CHANGED));
        setAsking(false);
        navigate(AGENTS_ROUTE);
      })
      .catch((err: unknown) => setFailure(errorText(err)))
      .finally(() => setBusy(false));
  };
  const missions = preview?.pausesMissions.map(missionWords) ?? [];
  const plugins = preview?.unusedPlugins ?? [];
  const handedBy = (preview?.handedWorkBy ?? []).map((h) => `@${h}`);
  return (
    <Panel>
      <Toolbar>
        <div className="agent-remove-text">
          <strong>Remove from team</strong>
          <span className="muted">Its file goes to the trash folder; what it remembers and its conversations stay.</span>
        </div>
        <Button variant="danger-ghost" onClick={ask}>Remove {name}…</Button>
      </Toolbar>
      {asking ? (
        <Modal
          title={`Remove ${name} from your team?`}
          onClose={() => setAsking(false)}
          foot={
            <>
              <Button variant="ghost" onClick={() => setAsking(false)}>Cancel</Button>
              <Button variant="danger" disabled={busy || !preview} onClick={remove}>Remove from team</Button>
            </>
          }
        >
          <ErrorBanner message={failure} />
          {preview ? (
            <div className="ui-stack" data-testid="remove-preview">
              <p>@{preview.handle}’s folder moves to the trash folder, so it can be brought back by hand.</p>
              {missions.length > 0 ? <p>Its {missions.length === 1 ? 'mission' : 'missions'} {and(missions)} {missions.length === 1 ? 'is' : 'are'} paused.</p> : null}
              {handedBy.length > 0 ? <p>{and(handedBy)} will stop handing work to it.</p> : null}
              {plugins.length > 0 ? (
                <p>
                  No other agent uses {and(plugins.map(pluginTitle))}; it stays installed.{' '}
                  <a href={settingsRoute('plugins')} onClick={(e) => { e.preventDefault(); setAsking(false); navigate(settingsRoute('plugins')); }}>Remove {plugins.length === 1 ? 'it' : 'them'} in Settings → Plugins</a>.
                </p>
              ) : null}
            </div>
          ) : failure ? null : (
            <p className="muted">Reading what it would change…</p>
          )}
        </Modal>
      ) : null}
    </Panel>
  );
}
