# Changelog

All notable changes to Wikinest are documented here.

## [1.1.0] - 2026-07-30

### Added

- Open-source Chrome/Edge side-panel extension for saving bookmarks, reviewing
  selected text, and writing confirmed web clips to the Vault.
- Dedicated bookmark and web-clip collections, generated bookmark summaries and
  tags, tag filtering, and semantic indexing for captured content.
- Live H2/H3 table of contents beside the unified Markdown editor.
- Demo-data seeding script for local product testing.

### Improved

- Long notes are organized in bounded chunks instead of being truncated, with a
  longer per-chunk timeout for slower models.
- Vault sync now uses conditional remote initialization and tighter shutdown
  coordination to protect concurrent setup and in-flight syncs.
- Bookmark and clip AI actions can use an extension-specific OpenAI-compatible
  model configuration without changing the desktop model.
- Docker builds now include the production unified-editor assets.

### Fixed

- Non-note content no longer participates in note classification or digest
  generation.
- Desktop shutdown can force-close a timed-out sync engine without allowing late
  state writes.
- The unified editor once again shows a responsive, real-time article outline.

[1.1.0]: https://github.com/qingkongzhiqian/wikinest/releases/tag/v1.1.0
