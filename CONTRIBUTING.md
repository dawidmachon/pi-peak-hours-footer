# Contributing peak-hours rules

This project ships a built-in table of provider peak/off-peak rules
(`src/defaults.ts`). It's meant to grow as a community-maintained "good
default table" so every user gets correct timings out of the box.

## Where rules live

- **Canonical defaults for everyone**: `src/defaults.ts` (`DEFAULT_PROVIDERS`).
  Changes here ship to all users via a package release.
- **Personal / private overrides**: the user config file
  (`~/.pi/agent/peak-hours.json`) — no code, no PR needed.

## Data conventions (please keep)

1. **Absolute instants are UTC** with a `Z` suffix:
   - `campaign.start` / `campaign.end` — e.g. `"2026-09-02T16:00:00Z"`.
   - `weekendOffPeakFrom` — an instant, e.g. `"2026-08-22T16:00:00Z"`.
2. **`HH:mm` windows are wall-clock on the provider's billing calendar**
   (`calendarOffsetMinutes`), **not UTC**. The day/weekday axis is read on
   that calendar, so storing windows in UTC would mis-classify near day
   boundaries. Examples:
   - GLM (UTC+8, `calendarOffsetMinutes: 480`): peak `14:00-18:00` = SGT.
   - DeepSeek (UTC+8): `09:00-12:00, 14:00-18:00` = UTC 01:00-04:00, 06:00-10:00.
3. **Exclusive ends**: `campaign.end` and window `end` are exclusive
   (`18:00` means peak stops at 17:59:59). A campaign "Sep 3 → Sep 20" is
   `start = 2026-09-02T16:00:00Z` (= Sep 3 00:00 SGT) and
   `end = 2026-09-20T16:00:00Z` (= Sep 21 00:00 SGT).
4. Overnight windows are fine: `end <= start` wraps past midnight
   (e.g. `23:00 → 09:00`).
5. **No free-form prose fields.** The `/peak` report derives everything from
   structure (windows, weekdays, multipliers, `weekendOffPeakFrom`, `source`).
   Campaign-only facts that cannot be derived go in the `details` array
   (short fragments, rendered as ` · fact`), e.g. `["ZCode: 0 quota"]`.
   Keep `source` (official URL) and add the date you verified the rule in the
   entry comment.

## How to add a provider

1. Add a `ProviderRule` in `src/defaults.ts`:
   - `id` = the pi provider id (check `~/.pi/agent/models-store.json` / `pi --list-models`),
     plus `aliases` for alternate ids.
   - `calendarOffsetMinutes`, `windows`, `peakWeekdays`, multipliers, `source`.
   - Per-model multipliers/`campaigns` under `models` (glob ids supported).
2. Add a **test vector** in `test/core.test.ts` proving boundary classification
   (e.g. "Fri 17:59 SGT peak, 18:00 not", "Sat off-peak").
3. Run `npm run check` (typecheck + all tests).
4. Open a PR. Include the official announcement URL in the entry.

## Privacy / public-repo hygiene

This is a public repo. Before pushing, run:

```bash
rg -iE "confuoco|fred|@local|home" --glob '!node_modules/**' .
```

Only the public identity `dawidmachon <ja@machon.net>` may appear.