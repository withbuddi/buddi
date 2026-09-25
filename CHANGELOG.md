# Changelog

What changes in buddi from one release to the next, newest first.

## Unreleased

### Changed

- The agents' Chromium now lives in the data directory, at `browser/engines`, so a container that keeps its data volume keeps the browser too.

### Fixed

- When the system will not let Chromium start its sandbox, the browser status says so in one sentence with the command to run, and the check now tests the browser with the sandbox on.
- A model that turns images down no longer stops the run: buddi sends the turn again with each screenshot replaced by a line of text.

Releases up to 0.1.0-pre.17 are described on their GitHub release pages: https://github.com/withbuddi/buddi/releases
