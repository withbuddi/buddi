# Changelog

What changes in buddi from one release to the next, newest first.

## Unreleased

### Added

- Settings → System → Version shows what changes in a newer buddi before you upgrade to it.
- When a newer buddi is ready, Home says so under the greeting and Settings gets a dot in the sidebar.

### Changed

- The dashboard's type is DM Sans, with DM Mono for code, shipped inside the package. It loads no font from the internet, as before.
- The agents' Chromium now lives in the data directory, at `browser/engines`, so a container that keeps its data volume keeps the browser too.

### Fixed

- In the collapsed agent rail, the groups separator, the + button and a group's faces now sit on the rail's centre line.
- Settings → Version now reads the running version from the installed package, which is named `@withbuddi/buddi`, instead of falling back to the core library's version.
- When the system will not let Chromium start its sandbox, the browser status says so in one sentence with the command to run, and the check now tests the browser with the sandbox on.
- A model that turns images down no longer stops the run: buddi sends the turn again with each screenshot replaced by a line of text.

Releases up to 0.1.0-pre.17 are described on their GitHub release pages: https://github.com/withbuddi/buddi/releases
