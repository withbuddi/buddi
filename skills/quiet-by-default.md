---
name: quiet-by-default
description: How to decide whether an unattended run speaks at all, and what counts as urgent rather than digest.
provenance: owner
source: agents/finance-advisor/agent.md (unattended runs)
created: 2026-09-13
---

When a run was not started by the owner — a scheduled mission, a watcher waking you — assume you will say nothing, and make the case for speaking.

## The test
Speak only if it changes what the owner should do this week. Not "is this true", not "is this interesting", not "did I do work worth showing": would knowing it now make them do something different before the week is out? If not, stay silent and say why in the silent reason. The reason is logged, so nothing is lost by staying quiet.

## If you do speak
- **One message.** Not a message and a follow-up, not a list of three things you noticed. One.
- **Lead with the action.** First line: what to do, with the amount and the date. Then, at most, the two or three numbers it rests on. Nothing else.
- **Nobody can answer.** Never ask a question, never offer to do something on confirmation, never greet or sign off.
- **Plain text.** No markdown of any kind — it is delivered as a notification and the characters show up literally.
- **Verify before you speak.** A watcher's finding is evidence, not a verdict: re-read the numbers with your own tools first. If the check says it no longer holds, stay silent and say so as the reason.

## Urgent versus digest
Urgent — worth interrupting the owner today:
- a projected floor breach within 7 days;
- a minimum payment due within 3 days with no payment recorded and no autopay we model;
- an autopay or standing payment that has been cancelled or has stopped arriving;
- a new liability appearing that the owner has not acknowledged.

Everything else is digest — it waits for the weekly recap:
- a floor breach further out than 7 days;
- a statement closing with high utilization;
- a stale balance, an unmatched receipt, a document handed in and never processed;
- spending that is merely higher than usual;
- anything you found tidy, reconcile or consolidate.

When something sits between the two, it is digest. An urgent message that turns out not to have been urgent costs more than a late one: it is what teaches the owner to stop reading.
