/**
 * Built-in rule data (providers, models, campaigns) shipped with the extension.
 *
 * These are DEFAULTS: they are compiled in so the extension works out of the
 * box, but every field can be overridden or extended from
 * `~/.pi/agent/peak-hours.json` without rebuilding (see src/config.ts for the
 * merge semantics and peak-hours.example.json for the shape).
 *
 * DATA FILE CONVENTION (keep consistent):
 * - Absolute instants (`campaign.start`, `campaign.end`, `weekendOffPeakFrom`)
 *   are stored in UTC with a `Z` suffix — the extension resolves them to a
 *   fixed instant regardless of who runs it.
 * - `HH:mm` windows (`windows`, `campaign.window`) are wall-clock times on the
 *   PROVIDER'S BILLING CALENDAR (`calendarOffsetMinutes`), NOT UTC — the
 *   billing math reads weekdays on that calendar, so this is the only
 *   unambiguous choice. Keep timings correct here; the extension does not
 *   guess timezones.
 *
 * CONTRIBUTING: this file is the canonical "good default table". To add a
 * provider for all users, add an entry + `source` URL + a test vector in
 * test/core.test.ts (see CONTRIBUTING.md). Personal overrides belong in the
 * user config file instead.
 */
import type { ProviderRule } from "./core.ts";

/** Z.AI GLM Coding Plan. Billing calendar: UTC+8 (Singapore Time, no DST). */
export const GLM: ProviderRule = {
	id: "zai", // pi uses provider id "zai" for GLM models (see ~/.pi/agent/models-store.json)
	aliases: ["glm", "zhipu"],
	label: "GLM Coding Plan",
	shortLabel: "GLM",
	calendarOffsetMinutes: 480, // UTC+8
	windows: [{ start: "14:00", end: "18:00" }], // peak: Mon-Fri 14:00-18:00 SGT
	peakWeekdays: [1, 2, 3, 4, 5],
	peakMultiplier: 1, // standard credit rate during peak
	offPeakMultiplier: 0.5, // off-peak = 50% of the standard credit rate
	models: [
		{
			id: "glm-5.3",
			label: "GLM-5.3",
			peakMultiplier: 3, // 1x off-peak, 3x peak (legacy V2 quota plans)
			offPeakMultiplier: 1,
		},
		{
			id: "glm-5.3-highspeed*",
			label: "GLM-5.3-HS",
			peakMultiplier: 3,
			offPeakMultiplier: 1,
		},
		{
			id: "glm-5.3-flash*",
			label: "GLM-5.3-Flash",
			peakMultiplier: 1.2, // 0.4x off-peak, 1.2x peak
			offPeakMultiplier: 0.4,
			campaigns: [
				{
					name: "GLM-5.3-Flash Usage Campaign",
					// VERIFIED vs official announcement ("II. Campaign Rules"):
					//   "Campaign period: September 3, 2026 to September 20, 2026."
					//   "every day from 23:00 to 09:00 the following day" (SGT)
					//   "applies on weekends and public holidays as well" → days 1-7
					// Instants are UTC (Z): start = Sep 3 00:00 SGT = Sep 2 16:00Z,
					// end (exclusive) = Sep 21 00:00 SGT = Sep 20 16:00Z.
					// The daily window is billing-calendar wall time (SGT, UTC+8).
					start: "2026-09-02T16:00:00Z",
					end: "2026-09-20T16:00:00Z",
					window: { start: "23:00", end: "09:00" },
					days: [1, 2, 3, 4, 5, 6, 7],
					quotaMultiplier: 2, // other supported agents: quota doubled; ZCode: 0
					label: "2× quota",
					details: ["ZCode: 0 quota"],
				},
			],
		},
		{
			id: "glm-5.2*",
			label: "GLM-5.2",
			// no multiplier overrides: falls back to the plan default (peak 1x / off-peak 0.5x)
		},
	],
	source: "https://docs.z.ai/devpack/overview",
};

/**
 * DeepSeek API. Peak hours: 01:00-04:00 and 06:00-10:00 UTC, Mon-Fri;
 * all other hours off-peak at half the peak rate. The vendor bills on a UTC+8
 * calendar, which is why the windows are stored as 09:00-12:00 / 14:00-18:00
 * UTC+8 — exactly 01:00-04:00 / 06:00-10:00 UTC.
 */
export const DEEPSEEK: ProviderRule = {
	id: "deepseek",
	label: "DeepSeek",
	shortLabel: "DS",
	calendarOffsetMinutes: 480, // UTC+8 (CN billing time)
	windows: [
		{ start: "09:00", end: "12:00" }, // 01:00-04:00 UTC
		{ start: "14:00", end: "18:00" }, // 06:00-10:00 UTC
	],
	peakWeekdays: [1, 2, 3, 4, 5],
	// Weekends fully off-peak since Aug 23, 2026 (weekday axis did not apply before).
	weekendOffPeakFrom: "2026-08-22T16:00:00Z",
	peakMultiplier: 1,
	offPeakMultiplier: 0.5, // off-peak = half of peak rates
	source: "https://api-docs.deepseek.com/quick_start/pricing/",
};

/** Built-in providers, in display order. */
export const DEFAULT_PROVIDERS: ProviderRule[] = [DEEPSEEK, GLM];