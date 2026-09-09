# pi-peak-hours-footer — project context

Loaded automatically when pi opens in this folder. Read this before touching
the code; it documents the design decisions and gotchas.

## Goal

A **footer** peak/off-peak billing-hours **+ promotion** indicator for the pi
coding agent. It shows a compact, decision-first status line via
`ctx.ui.setStatus("peak-hours", …)` only when the currently selected model
belongs to a configured provider, e.g.:

```
✓ off-peak · GLM-5.3-Flash · ×0.4 · until 14:00   ← OK to use
⚠ peak ×3   · GLM-5.3        · until 18:00         ← CAUTION
✗ peak ×3   · GLM-5.3        · until 18:00         ← AVOID
🎁 2× quota  · GLM-5.3-Flash · until 09:00          ← bonus (promo)
```

Inspired by `oglenyaboss/pi-peak-hours` (widget-based) but rewritten to be
config-driven and modular: rules are DATA in `~/.pi/agent/peak-hours.json`, so
providers/models/promotions can be added without rebuilding.

## Architecture (do not regress)

- `src/index.ts` — thin glue: `setStatus("peak-hours", …)` (append-only; never
  `setFooter`/`setWidget`), 30s `unref()`'d ticker created in `session_start`
  and cleared in `session_shutdown`, `/peak` + `/ph` commands.
- `src/core.ts` — PURE logic, zero imports beyond types: billing-calendar
  window math (incl. overnight windows like 23:00–09:00), `*` globs, provider →
  model rule resolution, campaign evaluation (auto date tracking), and
  next-state-change scanning. No `fs`, no pi imports.
- `src/config.ts` — loads `~/.pi/agent/peak-hours.json` (env override
  `PEAK_HOURS_CONFIG`, else `$PI_CODING_AGENT_DIR/agent/` else `~/.pi/agent/`).
  Validates tolerantly, then MERGES over built-ins: providers patch by id,
  models by model id, campaigns by name. `enabled:false` removes,
  `disabled:true` removes a campaign, `replace:true` swaps wholesale.
- `src/defaults.ts` — built-in rules: GLM (provider id `zai`, aliases
  glm/zhipu; peak Mon-Fri 14:00-18:00 SGT UTC+8; glm-5.3 ×3/×1, glm-5.3-flash*
  ×1.2/×0.4 + Sep 3-20 2026 campaign 23:00-09:00 SGT ×2) and DeepSeek (UTC+8
  billing calendar = 01:00-04:00 & 06:00-10:00 UTC peaks; ×1/×0.5; weekends
  off since Aug 23 2026). Canonical "good default table" — see CONTRIBUTING.md.
  NO free-form `note` fields: the report derives everything from structure;
  campaign-only facts go in `details: string[]` (rendered ` · fact`).
- `src/render.ts` — Decision rating (`ok`/`caution`/`avoid` → ✓/⚠/✗/🎁), the
  compact status text, and the aligned all-models report (`/peak`, `/ph`).
  Status text is colored with the user's theme (`ctx.ui.theme.fg(...)`, same
  palette/font as the rest of the footer). Times shown in `displayTimezone`
  (user perspective); rule math stays on the billing calendar.

## Hard rules / gotchas (verified against pi source)

1. **`ctx.model.provider` is a STRING** (provider id), not an object — see
   `dist/core/extensions/types.d.ts` / the `model-status.ts` example. Never do
   `model.provider.id`. `model.name` is the display name (fall back to `id`).
2. **Append-only footer.** Use `setStatus(key, text)` only — it is keyed and
   pi concatenates statuses from ALL extensions (crofai uses
   `setStatus("crofai-usage", …)`; ours uses `"peak-hours"`; both coexist).
   NEVER use `setFooter()` — it replaces the whole footer and would clobber
   (and be clobbered by) other extensions. `setWidget()` was upstream's choice
   and also pushes the editor — avoid.
3. Rules are evaluated on the **billing calendar** (`calendarOffsetMinutes`
   fixed shift), never local time — the two calendars disagree on weekdays.
   The `weekendOffPeakFrom` gate is evaluated on the classified instant, not
   "now".
4. No runtime deps. Pi core packages go in `peerDependencies` (see
   `docs/packages.md`); devDeps are only for local typecheck/tests.
5. Background timers: create in `session_start`, clear in `session_shutdown`,
   `.unref()` them. The factory itself must not start background work.

## Testing

- `node test/core.test.ts` — window math, overnight wrap, globs, GLM/DeepSeek
  classifications, campaign boundaries, multiplier resolution, footer text +
  rating + report.
- `node test/config.test.ts` — load/merge semantics via a temp
  `PEAK_HOURS_CONFIG` file (no `placement` — that concept was dropped).
- `node test/status.test.ts` — setStatus smoke test (append-only, coexistence).
- `node test/selfcheck.ts` — extension wiring + `/peak` `/ph` smoke test.
- `npm run check` = `tsc --noEmit` + all four.

Node runs `.ts` natively (v23+); no build step needed.

## Open items / notes

- MiniMax: user has models on `minimax` provider but no published peak hours
  provided yet — ship disabled placeholder (see `peak-hours.example.json`).
- Config patches must use the built-in **id** (`zai` for GLM), not an alias, to
  merge instead of add.
- **Parallel sessions hazard**: another pi instance editing this folder will
  overwrite files under you (happened 2026-09-09: it created then deleted
  `src/footer.*` drafts and rewrote `render.ts`/`index.ts`). Coordinate before
  running two agents on this repo simultaneously; `git diff` before trusting
  the tree.