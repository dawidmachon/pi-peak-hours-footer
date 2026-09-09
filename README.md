# pi-peak-hours-footer

Peak/off-peak billing-hours **and promotion (campaign)** indicator for the
[pi coding agent](https://github.com/earendil-works/pi-coding-agent), rendered
in the footer as a **keyed status line** (append-only — pi concatenates keyed
extension statuses, so it coexists with any other extension's footer content
with zero conflict).

The indicator appears only when the currently selected model belongs to a
configured provider, and its first token is an immediate GO/STOP signal:

```
✓ off-peak ×0.4 · GLM-5.3-Flash · until 14:00   ← OK to use (cheap)
⚠ peak          · DeepSeek      · until 10:00   ← CAUTION (peak hours, standard rate)
✗ peak×3        · GLM-5.3       · until 18:00   ← AVOID (very expensive)
🎁 2× quota      · GLM-5.3-Flash · until 09:00   ← bonus (promo active)
```

## Features

- **Append-only footer** — uses `ctx.ui.setStatus("peak-hours", …)`. pi
  concatenates keyed extension statuses, so it never replaces or breaks any
  other extension's footer content.
- **Config-driven rules** — providers, models, and time-windowed promotions are
  **data** in `~/.pi/agent/peak-hours.json`. Add a provider/model/campaign with
  a config edit; no rebuild, no code changes.
- **Campaign support with automatic date tracking** — promotions activate and
  deactivate automatically from the system clock (e.g. GLM's Sep 2026
  GLM-5.3-Flash Usage Campaign: daily 23:00–09:00 SGT, weekends included).
- **Billing-calendar correct** — all window/weekday math runs on the vendor's
  billing calendar (fixed UTC offset), never on the user's local clock, so
  weekdays and edges are classified exactly as billed. Handles overnight
  windows (`23:00–09:00`).
- **Lightweight** — zero runtime dependencies. Native `Intl` for display
  timezone, `Date` math for rules. `package.json` declares only pi core
  packages as peer/dev dependencies.

## Install

```bash
# From npm (recommended):
pi install npm:pi-peak-hours-footer

# From a local checkout (one-off test):
pi -e /path/to/pi-peak-hours-footer

# From a local checkout (persistent):
pi install /path/to/pi-peak-hours-footer
```

Config lives at `~/.pi/agent/peak-hours.json` and is re-read on `/reload`.

## Commands

- **`/peak`** — all-models report at the current moment: one line per tracked
  model with its state + OK/CAUTION/AVOID rating, plus windows/campaigns.
- **`/ph`** — shorter alias for `/peak`.

## Config

The file is the source of truth. Built-in rules (GLM + DeepSeek, see below)
are merged underneath, so you only write **deltas**: patch a provider, add a
model, or add/disable a campaign. See [`peak-hours.example.json`](./peak-hours.example.json)
for a copy-ready template.

### Data conventions (keep the data file consistent)

- **Absolute instants are UTC** with a `Z` suffix — `campaign.start`,
  `campaign.end`, `weekendOffPeakFrom`. They resolve to the same instant for
  every user regardless of their timezone.
- **`HH:mm` windows are wall-clock on the provider's billing calendar**
  (`calendarOffsetMinutes`), **not UTC** — the weekday axis is read on that
  calendar (e.g. GLM peak `14:00-18:00` is SGT; DeepSeek `09:00-12:00,
  14:00-18:00` = UTC 01:00-04:00, 06:00-10:00).
- Ends are **exclusive** (`18:00` stops at 17:59:59); overnight windows wrap
  (`23:00 → 09:00`).
- The user is responsible for supplying correct timings — the extension never
  guesses a timezone.

```jsonc
{
  "timezone": "auto",          // LEGACY alias, optional; falls back to displayTimezone
  "displayTimezone": "auto",    // USER-perspective times: "auto" = system zone | IANA zone
  "show": "always",             // "always" (peak + off-peak) | "peak" (only peak/campaign)
  "tickSeconds": 30,           // footer refresh interval (5–3600)
  "providers": [
    {
      // patch a built-in provider by its id ("zai" = GLM), or add a new one
      "id": "zai",
      "aliases": ["glm", "zhipu"],
      "label": "GLM Coding Plan",
      "shortLabel": "GLM",
      "calendarOffsetMinutes": 480,           // billing calendar (UTC+8 → 480)
      "windows": [{ "start": "14:00", "end": "18:00" }], // peak windows in billing time
      "peakWeekdays": [1, 2, 3, 4, 5],        // ISO: 1=Mon..7=Sun
      "peakMultiplier": 1,                    // quota burn during peak (1 = standard)
      "offPeakMultiplier": 0.5,               // quota burn off-peak
      "models": [
        {
          "id": "glm-5.3",                    // model id or glob ("glm-5.3*"); exact wins
          "label": "GLM-5.3",
          "peakMultiplier": 3,
          "offPeakMultiplier": 1
        },
        {
          "id": "glm-5.3-flash*",
          "label": "GLM-5.3-Flash",
          "peakMultiplier": 1.2,
          "offPeakMultiplier": 0.4,
          "campaigns": [
            {
              "name": "GLM-5.3-Flash Usage Campaign",
              "start": "2026-09-02T16:00:00Z", // inclusive, UTC (Z)
              "end": "2026-09-20T16:00:00Z",   // exclusive, UTC (Z)
              "window": { "start": "23:00", "end": "09:00" }, // optional daily window, billing-calendar wall time (overnight OK)
              "days": [1, 2, 3, 4, 5, 6, 7],        // omitted = every day incl. weekends/holidays
              "quotaMultiplier": 2,                  // 2 = double quota, 0 = free
              "label": "2× quota",                   // footer effect text
              "details": ["ZCode: 0 quota"]          // optional short facts, rendered as " · fact"
            }
          ]
        }
      ],
      "source": "https://docs.z.ai/devpack/overview"
    }
  ]
}
```

### Merge semantics (deltas, not replacement)

- Providers patch built-ins **by id**. Scalars/arrays on the file entry win;
  `models` merge by model id, `campaigns` merge by campaign `name`.
- Remove a built-in: `"enabled": false` on a provider/model,
  `"disabled": true` on a campaign.
- Fully swap an entry: `"replace": true`.
- Brand-new ids are simply added. A new provider should set
  `calendarOffsetMinutes` and at least one `windows` entry.

### Built-in rules (compiled-in defaults, editable via config)

| Provider | Billing calendar | Peak hours | Off-peak |
|---|---|---|---|
| **GLM Coding Plan** (`zai`/`glm`/`zhipu`) | UTC+8 (SGT) | Mon–Fri 14:00–18:00 SGT | 50% of standard credit rate |
| **DeepSeek** | UTC+8 (CN) | Mon–Fri 01:00–04:00 & 06:00–10:00 UTC (= 09:00–12:00 & 14:00–18:00 UTC+8) | half of peak rates |

GLM model multipliers (legacy V2 quota plans):
- `glm-5.3` / `glm-5.3-highspeed*`: **×3 peak / ×1 off-peak**
- `glm-5.3-flash*`: **×1.2 peak / ×0.4 off-peak**, plus the **GLM-5.3-Flash
  Usage Campaign** (Sep 3–20 2026, daily 23:00–09:00 SGT, weekends/holidays
  included): **2× quota for agents** (ZCode: 0).
- other GLM models: plan default (×1 peak / ×0.5 off-peak)

Adding other providers (e.g. MiniMax) is a config edit — see the commented
placeholder in `peak-hours.example.json`.

## Contributing peak rules

The built-in table in `src/defaults.ts` is the community "good default table".
To add a provider for all users, add an entry + test vector and open a PR —
see [`CONTRIBUTING.md`](./CONTRIBUTING.md). Personal overrides go in your
`~/.pi/agent/peak-hours.json` (no code).

## Development

```bash
npm install
npm run check     # typecheck + core/config/status tests + selfcheck
node test/core.test.ts      # pure window/campaign math + footer text
node test/config.test.ts    # config load/merge
node test/status.test.ts    # setStatus wiring smoke test
node test/selfcheck.ts      # extension wiring + /peak /ph smoke test
```

Layout:

```
src/
├── index.ts    # Extension entry: events, timer, setStatus, /peak + /ph
├── core.ts     # Pure logic: windows, overnight wrap, globs, campaigns, next-change
├── config.ts   # Load/validate/merge ~/.pi/agent/peak-hours.json over defaults
├── defaults.ts # Built-in rules: GLM (+ campaign), DeepSeek
└── render.ts   # Decision rating + footer/status text + all-models report
```

## References

- pi extension API: `docs/extensions.md`, `docs/packages.md`
- Footer rendering: `dist/modes/interactive/components/footer.js` —
  `getExtensionStatuses()` → one line per key, sorted, truncated; newlines
  sanitized to spaces.

## License

MIT.