# Changelog

Notable user-facing changes to the LLM for Zotero plugin. Format follows
[Keep a Changelog](https://keepachangelog.com/); versions match
`package.json`.

## 3.11.4 - 2026-09-25

### Fixed

- Zotero 9 compatibility: `pdf.getFulltext` no longer returns per-page
  character counts, so section reading through the reader outline never
  engaged. Page offsets are now derived from the form-feed separators in the
  extracted text.

### Changed

- `paper_read({ sections })` no longer falls back to chunk-label matching on
  papers without a structural section index. Such papers now report
  `no_section_index` with guidance to open the paper in a reader tab, parse it
  with MinerU, or use `paper_query`/`pages` — instead of silently returning
  chunk-sized fragments.

## 3.11.3 - 2026-09-24

### Fixed

- Reader chat toolbar button appears in session-restored readers at startup;
  the docked panel tracks sidebar open/close and width changes without
  intermittently covering the outline.
- `paper_read` accepts JSON-stringified page arrays, and plain PDFs expose
  their real outline sections to section-based reading.
- The manual MinerU parsing button reports completion and failures instead
  of remaining in the running state.

### Added

- **`paper_query` — find passages by what they say.** Relevance-ranked
  textual evidence for a natural-language query (`paper_query({ query })`),
  with retrieval planning (translations, acronyms, notation variants)
  handled internally. Semantic search no longer hides inside `paper_read`.
- **`paper_read` reads whole sections.** `sections:['Related Work']` returns
  the full section text through real section-label matching (numbering-,
  case-, and typo-tolerant), and unmatched names come back with near-miss
  suggestions and the paper's available section list instead of silence.
- **`labels` select figures by name.** `paper_read({ labels:['Figure 3'],
images:true })` extracts precisely those crops; `images:true` alone
  returns all figures; bare page ranges (`'16-18'`) now parse as the schema
  always claimed.
- **The open reader page joins the turn as ambient context.** The envelope
  now shows where the user is looking (`Open reader page: contextItemId=…,
page="7"`) so "this page" resolves without a tool call.

### Changed

- **Agent turns no longer hoard their own narration.** Assistant text that
  rides on a tool-call step ("Let me read more of the paper…") is
  non-critical by contract: the live agent trace still shows it, but it is
  no longer persisted into the reusable cross-turn transcript and can no
  longer ride semantic-compaction checkpoints into later turns. Only the
  turn's final answer stays verbatim; tool calls stay paired with their
  results.
- **BREAKING: `paper_read` takes structured coordinates, not a mode enum.**
  The `mode` parameter is gone — the presence of `sections`/`pages`/
  `labels`/`images`/`readFullReason` selects the path, and a call with no
  locator arguments is the overview preset. `query`, `queryVariants`,
  `topK`, `neighborPages`, `maxChars`, and `targets` are removed (an array
  goes into `target`; semantic search lives in `paper_query`); `capture` is
  gone in favor of the ambient reader page. Old-style calls fail with a
  one-hop migration error pointing at the new syntax.
- **Model knowledge is registry data, end to end.** The registry gained a
  `familyFallbacks` section (schema 2, additive; revision 8) carrying the
  per-family optimistic reasoning ladders for models no entry matches, a
  `suffix` matcher for "starts-with and ends-with" model patterns, and
  reasoning ladders for the qwen variants and every claude generation —
  the code-side profile table (`utils/reasoning/profile.ts`) and six
  per-family encoders (openai, grok, gemini, deepseek, kimi, mimo) are
  gone, along with the profile facade's per-family queries. Adding a
  model, a new claude generation's ladder, or retuning a family's
  fallback levels is now a JSON edit; the gpt-3/4 "no reasoning" guards
  became explicit `kind:"none"` registry entries. qwen and anthropic keep
  custom encoders for what data cannot express — qwen's host-dependent
  field placement and "default sends nothing" tri-state, anthropic's
  adaptive/manual mode negotiation with a max-tokens-clamped budget — but
  both read their ladders from the registry, and registry controls outrank
  them whenever present. A unified family surface (`utils/llmFamilies.ts`)
  exposes limits, reasoning options, defaults, reserve budgets, and
  encoding behind one key — `LLM_FAMILIES[provider]` — with one encoder
  per family chosen from a table (the generic registry translator shared
  by every declarative family, plus the two custom ones).
- **DIP/LoD remediation across the LLM stack** (behavior-preserving). The
  utility-LLM planner's eight-spelling probe for thinking budgets became a
  single capability-layer resolver (`getReasoningOptionReserveTokens`); the
  Gemini thinkingConfig camel/snake duality is decoded once
  (`extractGeminiThinkingConfig`) instead of being carried by two
  consumers; "this family starts with reasoning off" is profile data
  (`prefersReasoningOff`) instead of four hardcoded provider checks; the
  reasoning types stopped being re-exported through the 4k-line llmClient
  (payload builders split into `utils/llmPayloads.ts`); and
  the panel's per-runtime branching gained shared building blocks under
  `contextPanel/conversationBackend/` (runtime catalog state machine,
  active-conversation memory, standalone identity resolution, upstream
  reasoning selection ladder, codex-native turn predicate) — replacing
  hand-rolled copies in setupHandlers/chat/standaloneWindow. The send/retry
  main-flow merge is deliberately deferred until its branch coverage has
  unit tests.

## 3.11.2 - 2026-09-18

### Added

- **GLM-5.3 capability registry entry** — glm-5.3 and glm-5.3-flash get their
  real limits (1M context, 131072 output) plus a thinking-effort selector
  (max / high / low) matching the model's forced-thinking behavior.

### Fixed

- glm-5.3-flash had no thinking levels in the chat selector: the reasoning
  provider gate (`ReasoningProviderKind`) did not know the glm family, so the
  model resolved to `unsupported` and the send path dropped the selected
  effort before it reached the request. `glm` is now a first-class reasoning
  provider end-to-end (registry levels compile as before).
- Per-provider thinking-level memory silently dropped glm and mimo
  selections: the persisted-key whitelist was a hand-copied subset of the
  provider list. All provider-keyed sets now derive from the single provider
  identity table, and a test pins the full member set.

### Changed

- **Provider identity has a single source of truth** (`src/utils/provider.ts`).
  The "which provider families exist" knowledge was hand-copied across twelve
  lists with diverging member sets — the root cause of the glm-5.3-flash
  regression. Family ids, host tokens, labels, model-name rules, and the
  local-server detection now live in one zero-dependency module; every type,
  set, and switch derives from it.
- **Reasoning request encoders are per-family adapters**
  (`src/utils/reasoning/`), registered in one map that llmClient dispatches
  through — the per-family if/else chain is gone. Adding a family's thinking
  levels now means adding an adapter module plus a registry entry, without
  editing existing branches (open for extension). Declarative registry
  controls still take precedence; behavior is unchanged (pure refactor).
- The duplicated gemini native `thinkingConfig` fallback (llmClient and the
  agent's geminiNative adapter) and the two reasoning reserve-token tables
  are each merged into one copy.

### Changed (schema 2)

- **Reasoning level tables moved into the capability registry** (schema
  version 2, revision 6). OpenAI/GPT-5 (incl. codex and pro ladders), Grok,
  Gemini (2.5 budgets with their -1/0 sentinels and the 3.x level ladders),
  DeepSeek, MiMo, and Kimi k2/k2.5 now declare their levels as registry
  options, so they can be updated remotely without a plugin release. Options
  may carry `controlsByProtocol`, letting one entry encode the same level
  differently per wire protocol (Responses vs chat, Anthropic-compat,
  gemini_native). Older plugin builds reject the schema-2 registry outright
  and keep their bundled copy — they never see half-decoded data. The
  per-family adapters keep only optimistic fallbacks for models the registry
  has not learned yet; qwen (host-dependent encoding) and Anthropic (adaptive/
  manual thinking with a max-tokens-clamped budget) stay fully imperative.
  New model versions now land on the generic fallback first and gain their
  real ladder through a registry revision.

## 3.11.1 - 2026-09-15

### Fixed

- GLM via open.bigmodel.cn's Anthropic-compatible endpoint no longer fails
  with `max_tokens 参数非法`: an unset max-tokens fell back to the
  catalog's internal "unknown" sentinel and was sent as-is. Unset values
  now fall back to the catalogued model limit (GLM 4.6/4.5 added to the
  capability registry) or are omitted so the provider default applies.
- Compaction and context-usage budgeting now assume a conservative 128k
  window for models unknown to the capability catalog — previously the
  uncapped limit meant the compaction ratio was always zero and
  long conversations grew until the provider rejected them.

## 3.11.0 - 2026-09-14

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
