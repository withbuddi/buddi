/**
 * Offers: the few things an agent worked out that the owner might want done.
 *
 * Telegram draws these as inline buttons under the report they came with; the
 * dashboard draws the same rows as chips. Not a second mechanism — the same
 * `core.offers` rows, claimed by the same atomic update — so an offer taken on
 * the phone is gone from here on the next poll, and clicking one twice starts
 * one run.
 *
 * A chip authorizes nothing. Clicking it enqueues an ordinary run of the agent
 * that offered it, with the prompt that agent wrote; every tier and every
 * approval along that run is untouched. That is why the prompt is shown rather
 * than hidden behind the label: the owner can read exactly what they are about
 * to ask for, and anything that would then leave the machine still comes back
 * as an approval with the full preview.
 *
 * ## Both answers
 *
 * For a long time the only answer was yes. "Not now" is the other one, and it
 * is the reason this page is readable at all: an offer the owner refuses stops
 * appearing everywhere, immediately, and nothing runs. It is recorded rather
 * than deleted — under the fold below, with everything that lapsed on its own,
 * for a week — because "I said no to that" is worth being able to check.
 */
import { useState } from 'react';
import { api, lapseSentence, type OfferRow } from '../api';
import { fmtRelative } from '../format';
import { Button, Card, Details, Empty, ErrorBanner, List, ListRow, Notice, PageFrame, Panel, Pill, Stack, Toolbar, useAsync } from '../ui';
import { DismissAll } from './parts/DismissOffers';

export function Offers({ embedded, agentId, agentName }: { timezone?: string; embedded?: boolean; agentId?: string; agentName?: string }): JSX.Element {
  const { data, error, reload } = useAsync(() => api.offers(), [], 20_000);
  const mine = (o: OfferRow): boolean => !agentId || o.agentId === agentId;
  const rows = (data?.offers ?? []).filter(mine);
  const closed = (data?.closed ?? []).filter(mine);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [taken, setTaken] = useState<string | null>(null);

  const take = async (id: string, label: string): Promise<void> => {
    setFailure(null);
    setBusy(id);
    try {
      const result = await api.takeOffer(id);
      setTaken(
        result.jobId
          ? `On it — ${label}. Started as job ${result.jobId}.`
          : `Taken — ${label}. No worker is running here, so nothing has started yet.`,
      );
      reload();
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const dismiss = async (id: string, label: string): Promise<void> => {
    setFailure(null);
    setBusy(id);
    try {
      await api.dismissOffer(id);
      setTaken(`Dismissed — ${label}. It will not come back.`);
      reload();
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <PageFrame
      embedded={embedded}
      title="Offers"
      lede="Things an agent already worked out that you might want done. Taking one asks that agent the sentence it wrote. It authorizes nothing, and anything that would leave this machine still comes back to you as an approval."
    >
      <ErrorBanner message={error ?? failure} />
      {taken ? (
        <Notice tone="good" role="status">
          {taken}
        </Notice>
      ) : null}
      {rows.length > 0 ? (
        <Toolbar>
          <span className="ui-toolbar-spacer" />
          <DismissAll
            count={rows.length}
            agentId={agentId}
            agentName={agentName}
            onDone={() => { setTaken(null); reload(); }}
          />
        </Toolbar>
      ) : null}
      {!data || rows.length === 0 ? (
        <Empty>Nothing is on offer.</Empty>
      ) : (
        <Stack>
          {rows.map((offer) => (
            <Card
              key={offer.id}
              tone="accent"
              title={offer.label}
              meta={
                <>
                  <Pill mono>{offer.agentId}</Pill>
                  <span className="muted">expires {fmtRelative(offer.expiresAt)}</span>
                </>
              }
              actions={
                <>
                  {/* "Not now" beside "Take": both answers in the same place,
                      because an offer with only one answer is a chore. */}
                  <Button size="sm" variant="ghost" disabled={busy === offer.id} onClick={() => void dismiss(offer.id, offer.label)}>
                    Not now
                  </Button>
                  <Button variant="accent" size="sm" disabled={busy === offer.id} onClick={() => void take(offer.id, offer.label)}>
                    Take
                  </Button>
                </>
              }
            >
              <p className="ui-card-meta">{offer.prompt}</p>
            </Card>
          ))}
        </Stack>
      )}
      {closed.length > 0 ? (
        <Details summary={`Dismissed and lapsed (${closed.length})`} boxed>
          <Panel flush>
            <List>
              {closed.map((offer) => (
                <ListRow
                  key={offer.id}
                  title={offer.label}
                  sub={`${offer.agentId} — ${lapseSentence(offer)}`}
                  side={fmtRelative(offer.dismissedAt ?? offer.lapsedAt ?? offer.createdAt)}
                />
              ))}
            </List>
          </Panel>
          <p className="muted">These stop being shown a week after they closed.</p>
        </Details>
      ) : null}
    </PageFrame>
  );
}
