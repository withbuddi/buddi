# Built-in system context

Every agent run through the shared gateway wiring receives a turn-start clock
snapshot and a bounded host summary, including Dashboard, Telegram, CLI,
scheduled runs and delegates. No agent-file edits or approval grants are needed.

- `system.time` reads the clock and owner profile again on every call.
- `system.info` returns the same time information plus OS/version, kernel,
  architecture, hardware model when detectable, and host timezone. Host facts
  are cached for five minutes; unknown hardware or virtualization is not guessed.
- Owner profile timezone takes priority over configured `BUDDI_TZ`, with an
  explicit fallback when the profile is missing, invalid or unavailable.
- The resolved owner timezone also applies to tools in that run. Existing
  scheduled commitments retain their stored timezone; no schedules are rewritten.

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
