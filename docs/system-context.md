---
title: "Built-in system context"
status: reference
updated: 2026-09-25
---

# Built-in system context

Every agent run through the shared gateway wiring receives a turn-start clock
snapshot and a bounded host summary, including Dashboard, Telegram, CLI,
scheduled runs and delegates. No agent-file edits or approval grants are needed.

- `system.time` reads the clock and owner profile again on every call.
- `system.info` returns the same time information plus OS/version, kernel,
  architecture, hardware model when detectable, and host timezone. Host facts
  are cached for five minutes; unknown hardware or virtualization is not guessed.
- The owner's zone is the one in Settings → Profile. `BUDDI_TZ` only fills an
  empty profile at start and is the fallback while the profile names none (or
  is unreadable), then New York. The same zone drives the turn clock,
  `{{today}}` in agent prompts, tools, widgets ("here" on the World clock),
  reminders, digests and the dashboard's footer and lock clocks.
- A change in Settings → Profile (or through `owner.set_profile`) applies at
  once, with no restart: the server keeps the profile's zone in memory, updates
  it on every save and re-reads it every minute. Schedules kept in the old zone
  (the recap, the learning digest, recurring reminders) move to the new one as
  a new schedule revision; a schedule a plugin set in a zone of its own stays.
  At start, schedules still in the fallback zone move to the profile's zone
  when it names another (an installation from before the profile drove the clock).
- How the owner reads times and dates (Settings → Profile: 12-hour or 24-hour,
  "Thu, Oct 1", "Thursday, 1 October" or ISO) is one line under "About the
  owner" for every agent, so a reply writes "2:05 PM" to someone who reads
  12-hour time. Auto adds nothing.
- The front desk alone is also told the owner's places — each label, the
  address as typed, the town it was matched to and its zone — as context, the
  way it is told the timezone. Other agents are not; a plugin reads them only
  through its declared `owner:places`.

Host means the machine/environment running the Buddi server, not the browser
or Telegram client. macOS product version and hardware model identifier are read
using fixed, bounded system commands. Windows/Linux report available OS facts;
hardware model can be null. A hardware identifier is not guessed into a retail name.

No hostname, username, serial number, credentials, environment dump or private
filesystem inventory is included. These facts confer no browser, shell or file
access. Use separately granted status tools to check live host/computer permissions.

The two platform tools are separate from configurable agent grants. Their
schemas are appended by the shared runtime, and the actual tool set is recorded
in run events. The time context is authoritative over older dates in agent
personas/history; long-running tasks should call `system.time` again.
