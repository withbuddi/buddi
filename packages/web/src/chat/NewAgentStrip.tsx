/**
 * The line a new agent's chat opens with, once (docs/agents.md, "Delegation").
 *
 * An agent Agent Father creates asks everyone by default. The first time the
 * owner opens its chat, a strip under the header says so in one sentence —
 * whom it may ask and who may ask it, read from the gateway
 * (`GET /api/agents/:id/intro`) — with "Adjust" to its Setup → Team and a
 * close. Not a modal: the composer stays usable. Closing it, or following
 * "Adjust", is remembered by the gateway for that agent; agents that existed
 * before this never show it.
 */
import { useState } from 'react';
import { api, type AgentIntro, type IntroAgent } from '../api';
import { agentRoute } from '../routes';
import { Button, ButtonLink, useAsync } from '../ui';
import { Icon } from '../ui/Icon';

/** How many names the sentence spells out before it trails off. */
const NAMED = 3;

function named(agent: IntroAgent): string {
  return agent.frontDesk ? 'the front desk' : `@${agent.handle}`;
}

function listOf(agents: readonly IntroAgent[]): string {
  const names = agents.slice(0, NAMED).map(named);
  return agents.length > NAMED ? `${names.join(', ')}, …` : names.join(', ');
}

/** "New here. @x may ask everyone, and can be asked by the front desk, @art, …" */
export function newAgentSentence(intro: Extract<AgentIntro, { show: true }>): string {
  const asks =
    intro.asks === 'everyone' ? 'may ask everyone'
    : intro.asks.length === 0 ? 'asks nobody yet'
    : `may ask ${listOf(intro.asks)}`;
  const askedBy = intro.askedBy.length === 0 ? 'and nobody asks it yet' : `and can be asked by ${listOf(intro.askedBy)}`;
  return `New here. @${intro.handle} ${asks}, ${askedBy}.`;
}

export function NewAgentStrip({ agentId }: { agentId: string }): JSX.Element | null {
  const intro = useAsync(() => api.agentIntro(agentId), [agentId]);
  const [closed, setClosed] = useState(false);
  const data = intro.data;
  if (closed || !data || !data.show) return null;
  // Gone here at once; a failed write only means it shows once more.
  const close = (): void => {
    setClosed(true);
    void api.dismissAgentIntro(agentId).catch(() => {});
  };
  return (
    <div className="wb-new-agent" role="status" data-testid="new-agent-strip">
      <p className="wb-new-agent-text">{newAgentSentence(data)}</p>
      <ButtonLink variant="ghost" size="sm" href={agentRoute(agentId, 'setup', 'team')} onClick={close}>Adjust</ButtonLink>
      <Button variant="ghost" size="sm" className="ui-icon-btn" aria-label="Close" title="Close" onClick={close}>
        <Icon name="close" size={14} />
      </Button>
    </div>
  );
}
