-- An offer that hands the owner somewhere instead of asking its agent again.
--
-- The front desk, asked for a new agent, offers either a catalogue agent's
-- install sheet or "Continue with Agent Father" carrying the owner's request.
-- Both are buttons the owner taps; neither runs the offering agent. The row is
-- an ordinary offer (claim-once, lapses with the turn) with the destination:
--
--   handoff  null: an ordinary offer (taking it asks its agent the prompt).
--            {"kind":"install","package":"chef","title":"Chef"}: opens that
--            package's install sheet on the dashboard; nothing is claimed.
--            {"kind":"maker","agentId":"agent-father"}: switches the chat to
--            that agent and sends `prompt` (the owner's request) as the
--            owner's turn, once.
alter table core.offers
  add column if not exists handoff jsonb null;
