# Changelog

Notable user-facing changes to the LLM for Zotero plugin. Format follows
[Keep a Changelog](https://keepachangelog.com/); versions match
`package.json`.

## Unreleased

### Added

- **Library chat panel** below the item list — a resizable chat surface that
  anchors the library-wide conversation; selecting items only refreshes the
  attached context, never the conversation, and no item selection is required.
- **Library chat ambient context** — the collection currently open in the
  library pane and the highlighted item are mirrored into every library-chat
  turn as clearly marked _ambient_ metadata references (never counted as
  attached papers). Toggle it under
  `Preferences -> Agent -> Library Chat Ambient Context`.

### Changed

- Agent library edits are now per-action undoable, with a reworked
  write-consent flow.
- Library imports list the imported paper titles and the target collection
  directly in the chat trace.
- `paper_read` full-text reading no longer refuses based on the user's
  phrasing — the agent must state a `readFullReason` instead.
- The plugin no longer injects default sampling/output settings: an unset
  temperature or max-tokens is omitted from requests so the provider's own
  default applies, and models unknown to the capability catalog get no
  plugin-side input cap. (Anthropic's API requires `max_tokens`, so an unset
  value falls back to the catalogued model limit and is only omitted when the
  catalog does not know the model.)

### Fixed

- The library chat panel now mounts on first open — the toolbar toggle
  previously revealed an empty panel until restart.
- Keyboard events typed in the library chat panel no longer leak into the
  item tree (space / arrows / Enter were moving the item selection).
