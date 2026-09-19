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
 */
import { useState } from 'react';
import { api } from '../api';
import { fmtRelative } from '../format';
import { Button, Card, Empty, ErrorBanner, Notice, Page, PageHeader, Pill, Stack, useAsync } from '../ui';

export function Offers({ timezone: _timezone }: { timezone: string }): JSX.Element {
  const { data, error, reload } = useAsync(() => api.offers(), [], 20_000);
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

  return (
    <Page>
      <PageHeader
        title="Offers"
        lede="Things an agent already worked out that you might want done. Taking one asks that agent the sentence it wrote — it authorizes nothing, and anything that would leave this machine still comes back to you as an approval."
      />
      <ErrorBanner message={error ?? failure} />
      {taken ? (
        <Notice tone="good" role="status">
          {taken}
        </Notice>
      ) : null}
      {!data || data.offers.length === 0 ? (
        <Empty>Nothing is on offer.</Empty>
      ) : (
        <Stack>
          {data.offers.map((offer) => (
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
                <Button variant="accent" size="sm" disabled={busy === offer.id} onClick={() => take(offer.id, offer.label)}>
                  Take
                </Button>
              }
            >
              <p className="ui-card-meta">{offer.prompt}</p>
            </Card>
          ))}
        </Stack>
      )}
    </Page>
  );
}
