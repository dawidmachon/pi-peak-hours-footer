/**
 * Tests for src/config.ts — file loading, validation, and merge semantics.
 * Uses PEAK_HOURS_CONFIG to point at temp files; no pi runtime needed.
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, configPath } from "../src/config.ts";
import { chooseModelRule, findProvider } from "../src/core.ts";

const dir = mkdtempSync(join(tmpdir(), "peak-hours-test-"));
let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
	if (cond) console.log(`  ok   ${name}`);
	else {
		failures += 1;
		console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
	}
}
function useConfig(obj: unknown): void {
	writeFileSync(join(dir, "peak-hours.json"), JSON.stringify(obj, null, 2));
	process.env.PEAK_HOURS_CONFIG = join(dir, "peak-hours.json");
	console.log(`[config] wrote ${configPath()}`);
}

/* ── defaults (no file) ──────────────────────────────────────────────────── */

process.env.PEAK_HOURS_CONFIG = join(dir, "missing.json");
const defaults = loadConfig();
check("defaults: timezone auto", defaults.timezone === "auto");
check("defaults: displayTimezone auto", defaults.displayTimezone === "auto");
check("defaults: show always", defaults.show === "always");
check("defaults: tick 30s", defaults.tickSeconds === 30);
check("defaults: 2 built-in providers", defaults.providers.length === 2);
check("defaults: deepseek + glm present",
	findProvider(defaults.providers, "deepseek") !== undefined &&
	findProvider(defaults.providers, "zai") !== undefined);

/* ── basic overrides ─────────────────────────────────────────────────────── */

useConfig({ timezone: "Asia/Singapore", displayTimezone: "America/New_York", show: "peak", tickSeconds: 60 });
const cfg1 = loadConfig();
check("override: timezone", cfg1.timezone === "Asia/Singapore");
check("override: displayTimezone", cfg1.displayTimezone === "America/New_York");
check("override: show peak", cfg1.show === "peak");
check("override: tick 60", cfg1.tickSeconds === 60);
check("override: providers still built-ins", cfg1.providers.length === 2);

// Legacy: `timezone` alone falls back as the display zone when displayTimezone is unset.
useConfig({ timezone: "Asia/Singapore" });
const cfg1b = loadConfig();
check("fallback: timezone drives displayTimezone when unset",
	cfg1b.displayTimezone === "Asia/Singapore" && cfg1b.timezone === "Asia/Singapore");

/* ── add a new provider ──────────────────────────────────────────────────── */

useConfig({
	providers: [
		{
			id: "minimax",
			label: "MiniMax",
			shortLabel: "MM",
			calendarOffsetMinutes: 480,
			windows: [{ start: "09:00", end: "12:00" }],
			peakWeekdays: [1, 2, 3, 4, 5],
			offPeakMultiplier: 0.5,
		},
	],
});
const cfg2 = loadConfig();
const mm = findProvider(cfg2.providers, "minimax");
check("add: minimax present", mm !== undefined);
check("add: still 3 providers", cfg2.providers.length === 3);
check("add: glm retained", findProvider(cfg2.providers, "zai") !== undefined);

/* ── patch an existing provider: add a model, keep built-ins ────────────── */

useConfig({
	providers: [
		{
			id: "zai",
			models: [{ id: "glm-6.0*", label: "GLM-6.0", peakMultiplier: 4, offPeakMultiplier: 0.5 }],
		},
	],
});
const cfg3 = loadConfig();
const glm = findProvider(cfg3.providers, "zai")!;
check("patch: glm models now 5 (built-ins + new)", (glm.models ?? []).length === 5);
check("patch: built-in glm-5.3 kept", chooseModelRule(glm, "glm-5.3")?.peakMultiplier === 3);
check("patch: new glm-6.0 resolves", chooseModelRule(glm, "glm-6.0-mini")?.label === "GLM-6.0");
check("patch: glm windows kept", glm.windows.length === 1);
check("patch: glm offPeakMultiplier kept", glm.offPeakMultiplier === 0.5);

/* ── remove a built-in model + disable a built-in campaign (model-level) ── */

useConfig({
	providers: [
		{
			id: "zai",
			models: [
				{ id: "glm-5.2*", enabled: false },
				{ id: "glm-5.3-flash*", campaigns: [{ name: "GLM-5.3-Flash Usage Campaign", disabled: true }] },
			],
		},
	],
});
const cfg4 = loadConfig();
const glm4 = findProvider(cfg4.providers, "zai")!;
check("remove: glm-5.2 model rule gone", chooseModelRule(glm4, "glm-5.2") === null);
check("remove: glm-5.3 still present", chooseModelRule(glm4, "glm-5.3")?.peakMultiplier === 3);
check("remove: built-in flash campaign disabled by name-only stub",
	chooseModelRule(glm4, "glm-5.3-flash")?.campaigns?.length === 0);
check("remove: flash model multipliers kept",
	chooseModelRule(glm4, "glm-5.3-flash")?.peakMultiplier === 1.2);

/* ── disable an entire built-in provider ─────────────────────────────────── */

useConfig({ providers: [{ id: "deepseek", enabled: false }] });
const cfg5 = loadConfig();
check("disable: deepseek removed", findProvider(cfg5.providers, "deepseek") === undefined);
check("disable: glm kept", findProvider(cfg5.providers, "zai") !== undefined);
check("disable: 1 provider left", cfg5.providers.length === 1);

/* ── replace: swap a provider wholesale ──────────────────────────────────── */

useConfig({
	providers: [
		{
			id: "zai",
			replace: true,
			label: "My GLM",
			shortLabel: "GLM",
			calendarOffsetMinutes: 480,
			windows: [{ start: "00:00", end: "23:59" }],
			peakWeekdays: [1, 2, 3, 4, 5, 6, 7],
		},
	],
});
const cfg6 = loadConfig();
const glm6 = findProvider(cfg6.providers, "zai")!;
check("replace: label swapped", glm6.label === "My GLM");
check("replace: models dropped (wholesale)", (glm6.models ?? []).length === 0);
check("replace: windows swapped", glm6.windows[0].start === "00:00");

/* ── malformed entries are skipped, valid ones survive ──────────────────── */

useConfig({
	providers: [
		{ noId: true, label: "broken" },
		null,
		"nope",
		{ id: "zai", models: [{ id: 42 as unknown as string }], campaigns: [{ name: "x", start: "bad" }] },
	],
});
const cfg7 = loadConfig();
check("malformed: providers stay valid (2 built-ins)", cfg7.providers.length === 2);
check("malformed: glm survived", findProvider(cfg7.providers, "zai") !== undefined);
check("malformed: glm model rules intact", chooseModelRule(findProvider(cfg7.providers, "zai")!, "glm-5.3") !== null);

/* ── cleanup ─────────────────────────────────────────────────────────────── */

delete process.env.PEAK_HOURS_CONFIG;
rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? "\nconfig.test: all passed" : `\nconfig.test: ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);