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
  it on every save and re-reads it every minute.
- Every schedule records whether its zone was named on purpose
  (`core.schedule_specs.timezone_explicit`). One made without a zone — the
  recap, the learning digest, a plugin's mission that names none, an agent's
  `schedule.propose` without `timezone` — follows the owner's zone: a Profile
  change moves it as a new schedule revision, so its next run is 8 AM in the
  new zone. One whose creator named a zone (the tool's `timezone`, a mission
  that declares one, a zone chosen through `POST /api/missions/:id/schedule`)
  keeps it. At every start, schedules that follow the owner and sit in another
  zone move to it. Schedules from before the flag are settled once at start,
  by provenance: one buddi itself made without a zone (a plugin's default
  mission that names none, the learning digest, the first-run arc, a starter's
  or plugin agent's declared mission, matched by mission id and cron) that sits
  in the default zone of the time (`BUDDI_TZ`, else New York) or the Profile's
  follows the owner; any other, `schedule.propose` and dashboard ones
  included, keeps its zone, since nothing recorded whether it was named.
  Missions on the dashboard say "follows your timezone" instead of the zone;
  `buddi missions` adds it to the schedule line. A one-off reminder is an
  instant and does not move.
- `buddi doctor` (a checkout's table and a packaged install's Timezone line)
  names the zone and where it comes from — Settings → Profile, `BUDDI_TZ`, or
  the default — and this machine's own zone when it differs.
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
