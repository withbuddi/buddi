# A browser operator on a local vision model

Status: idea, 2026-09-23. To explore once the roadmap's main list is
mostly drained.

## The problem

Every agent that drives the browser or the computer pays for every
screenshot in its own context. A forty-step session drags forty images
through an expensive model, and the caller's conversation fills with
pixels that have nothing to do with what it was asked.

## The idea

One **browser operator** agent, bound to a local vision model through a
compatible-endpoint account (an MLX server on this Mac), is the only agent
that holds the browser and computer tools. Every other agent has just
`agent.delegate` and hands it a task in words — "sign in to the bank and
read the balance" — and gets back a few lines of text. The screenshots
never leave the operator.

## Why it is mostly configuration

- Provider accounts already allow a compatible endpoint per agent.
- The tool picker grants browser tools to exactly one agent.
- Delegation and groups already carry a task in and a result out.

So the first experiment is: create the agent, bind it, grant it, and let
the Finance Advisor's bank check delegate to it.

## What to watch

- **Grounding over many steps.** Local vision models read a screen well
  but are weaker at long multi-step plans. Keep tasks short and concrete;
  let the operator say "stuck" and hand back rather than loop.
- **Its own context.** A long session fills the operator's window too.
  The "long-running browser context compaction and no-progress recovery"
  item under Later becomes a prerequisite.
- **Text before pixels.** Check whether the browser plugin already reads
  the page as text where it can; if so the saving is smaller than it looks
  and the win is mostly keeping noise out of the caller.
- **A hybrid loop.** The operator could run the local model for the loop
  and escalate one step to a bigger model when it is stuck.

## What would change in code, if anything

Possibly nothing for the experiment. If it works, a way for the result to
carry a final screenshot on request (through the image renderer) and a
per-agent "this agent only receives delegated tasks" flag would make it
tidy.
