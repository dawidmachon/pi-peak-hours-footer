/**
 * Tests for src/core.ts (pure logic) + src/render.ts (footer text).
 * No test framework — plain assertions, `node test/core.test.ts`.
 */
import { DEEPSEEK, GLM, DEFAULT_PROVIDERS } from "../src/defaults.ts";
import {
	activeCampaignAt,
	chooseModelRule,
	computeStatus,
	findProvider,
	globMatch,
	inWindow,
	isPeakAt,
	nextCampaignChangeAt,
	nextStateChangeAt,
	parseHm,
	resolveRule,
	shifted,
	type ProviderRule,
} from "../src/core.ts";
import { resolveTimezone, statusText, reportLines, rateStatus, ratingWord, ratingReason, concreteModelId } from "../src/render.ts";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
	if (cond) {
		console.log(`  ok   ${name}`);
	} else {
		failures += 1;
		console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const glm = findProvider(DEFAULT_PROVIDERS, "zai")!;
const deepseek = findProvider(DEFAULT_PROVIDERS, "deepseek")!;

/* ── helpers ─────────────────────────────────────────────────────────────── */

check("parseHm: 14:00 → 840", parseHm("14:00") === 840);
check("parseHm: 9:05 → 545", parseHm("9:05") === 545);
check("parseHm: 23:59 → 1439", parseHm("23:59") === 1439);

check("inWindow normal: 14:59 inside", inWindow({ start: "14:00", end: "18:00" }, 14 * 60 + 59));
check("inWindow normal: 18:00 excluded", !inWindow({ start: "14:00", end: "18:00" }, 18 * 60));
check("inWindow wrap: 23:30 inside", inWindow({ start: "23:00", end: "09:00" }, 23 * 60 + 30));
check("inWindow wrap: 00:30 inside", inWindow({ start: "23:00", end: "09:00" }, 30));
check("inWindow wrap: 09:00 excluded", !inWindow({ start: "23:00", end: "09:00" }, 9 * 60));
check("inWindow wrap: 10:00 outside", !inWindow({ start: "23:00", end: "09:00" }, 10 * 60));

check("globMatch exact", globMatch("glm-5.3", "glm-5.3"));
check("globMatch exact≠prefix", !globMatch("glm-5.3", "glm-5.3-flash"));
check("globMatch suffix *", globMatch("glm-5.3-flash*", "glm-5.3-flash"));
check("globMatch mid *", globMatch("*flash*", "glm-5.3-flash"));
check("globMatch no match", !globMatch("glm-5.3*", "deepseek-chat"));

/* ── provider matching (pi uses "zai" for GLM) ───────────────────────────── */

check("findProvider by exact id (zai)", findProvider(DEFAULT_PROVIDERS, "zai") === GLM);
check("findProvider via alias (glm)", findProvider(DEFAULT_PROVIDERS, "glm") === GLM);
check("findProvider via alias (zhipu)", findProvider(DEFAULT_PROVIDERS, "zhipu") === GLM);
check("findProvider deepseek", findProvider(DEFAULT_PROVIDERS, "deepseek") === DEEPSEEK);
check("findProvider unknown → undefined", findProvider(DEFAULT_PROVIDERS, "openai") === undefined);

/* ── GLM peak windows (Mon-Fri 14:00-18:00 SGT = UTC+8) ──────────────────── */

const glm53 = resolveRule(glm, "glm-5.3");
const glmFlash = resolveRule(glm, "glm-5.3-flash");

check("glm-5.3 resolves to model rule", chooseModelRule(glm, "glm-5.3")?.id === "glm-5.3");
check("glm-5.3 peak multiplier 3", glm53.peakMultiplier === 3);
check("glm-5.3 off-peak multiplier 1", glm53.offPeakMultiplier === 1);
check("glm-5.3-flash peak multiplier 1.2", glmFlash.peakMultiplier === 1.2);
check("glm-5.3-flash off-peak multiplier 0.4", glmFlash.offPeakMultiplier === 0.4);
check("glm-5.2 falls back to provider defaults", resolveRule(glm, "glm-5.2").offPeakMultiplier === 0.5);

// 2026-09-04 is a Friday.
const fri15SGT = new Date("2026-09-04T15:00:00+08:00");
const fri1359SGT = new Date("2026-09-04T13:59:00+08:00");
const fri1800SGT = new Date("2026-09-04T18:00:00+08:00");
const sat15SGT = new Date("2026-09-05T15:00:00+08:00");

check("GLM Fri 15:00 SGT → peak", isPeakAt(glm53, fri15SGT));
check("GLM Fri 13:59 SGT → off-peak", !isPeakAt(glm53, fri1359SGT));
check("GLM Fri 18:00 SGT → off-peak (end exclusive)", !isPeakAt(glm53, fri1800SGT));
check("GLM Sat 15:00 SGT → off-peak", !isPeakAt(glm53, sat15SGT));

const peakSt = computeStatus(glm53, fri15SGT);
check("GLM-5.3 Fri 15:00 status kind peak", peakSt.kind === "peak");
check("GLM-5.3 peak until 18:00 SGT", peakSt.until?.getTime() === fri1800SGT.getTime());
check("GLM-5.3 off-peak → next change 14:00 SGT",
	nextStateChangeAt(glm53, fri1359SGT)?.getTime() === new Date("2026-09-04T14:00:00+08:00").getTime());

/* ── GLM-5.3-Flash usage campaign (Sep 3-20 2026, daily 23:00-09:00 SGT) ── */

const campFri0230 = new Date("2026-09-10T02:30:00+08:00"); // Fri inside campaign window
const campFri1000 = new Date("2026-09-10T10:00:00+08:00"); // inside period, outside window
const campEarlier = new Date("2026-09-01T02:30:00+08:00"); // before period
const campLater = new Date("2026-09-21T02:30:00+08:00"); // after period
const campSat0230 = new Date("2026-09-12T02:30:00+08:00"); // Sat (weekend) inside period

check("flash campaign active 02:30 SGT", activeCampaignAt(glmFlash, campFri0230)?.campaign.name === "GLM-5.3-Flash Usage Campaign");
check("flash campaign inactive outside daily window", activeCampaignAt(glmFlash, campFri1000) === null);
check("flash campaign inactive before period", activeCampaignAt(glmFlash, campEarlier) === null);
check("flash campaign inactive after period", activeCampaignAt(glmFlash, campLater) === null);
check("flash campaign active on weekend (Sat)", activeCampaignAt(glmFlash, campSat0230) !== null);

const flashCampSt = computeStatus(glmFlash, campFri0230);
check("flash 02:30 status kind campaign", flashCampSt.kind === "campaign");
check("flash campaign multiplier 2", flashCampSt.multiplier === 2);
check("flash campaign until 09:00 SGT", flashCampSt.until?.getTime() === new Date("2026-09-10T09:00:00+08:00").getTime());
check("flash after-campaign until skips straight to next peak",
	nextStateChangeAt(glmFlash, campFri1000)?.getTime() === new Date("2026-09-10T14:00:00+08:00").getTime());

// campaign with quotaMultiplier: 1 must render "×1" (not fall back to "×2");
// no `label` so the multiplier fallback path is exercised
const neutralProvider: ProviderRule = {
	id: "neutral",
	label: "N",
	shortLabel: "N",
	calendarOffsetMinutes: 480,
	windows: [{ start: "00:00", end: "24:00" }],
	peakWeekdays: [1, 2, 3, 4, 5, 6, 7],
	campaigns: [{
		name: "neutral test campaign",
		start: "2026-09-01T00:00:00+08:00",
		end: "2026-09-30T00:00:00+08:00",
		window: { start: "00:00", end: "24:00" },
		quotaMultiplier: 1,
	}],
};
const neutralSt = computeStatus(resolveRule(neutralProvider, "model-x"), campFri0230);
check("neutral campaign renders ×1 not ×2",
	(statusText(neutralSt, "N", campFri0230, "UTC") ?? "").includes("×1"),
	JSON.stringify(statusText(neutralSt, "N", campFri0230, "UTC")),
);

// Overnight daily-window edge: active at 23:30 SGT, ends at 09:00 next day.
const flashLate = new Date("2026-09-11T23:30:00+08:00");
check("flash 23:30 SGT campaign active", activeCampaignAt(glmFlash, flashLate) !== null);
check("flash 23:30 → next change 09:00 next day",
	nextCampaignChangeAt(glm, glmFlash.modelRule!.campaigns![0], flashLate)?.getTime() === new Date("2026-09-12T09:00:00+08:00").getTime());

/* ── DeepSeek (Mon-Fri 01:00-04:00 & 06:00-10:00 UTC, half off-peak) ─────── */

const ds940 = resolveRule(deepseek, "deepseek-chat");
check("deepseek off-peak multiplier 0.5", ds940.offPeakMultiplier === 0.5);
check("deepseek peak multiplier 1", ds940.peakMultiplier === 1);

const fri0200Z = new Date("2026-09-04T02:00:00Z"); // Fri 10:00 UTC+8 → 1st window
const fri0500Z = new Date("2026-09-04T05:00:00Z"); // Fri 13:00 UTC+8 → gap
const fri0700Z = new Date("2026-09-04T07:00:00Z"); // Fri 15:00 UTC+8 → 2nd window
const sat0200Z = new Date("2026-09-05T02:00:00Z"); // Sat → off-peak (weekend gate)

check("deepseek Fri 02:00Z → peak", isPeakAt(ds940, fri0200Z));
check("deepseek Fri 05:00Z → off-peak", !isPeakAt(ds940, fri0500Z));
check("deepseek Fri 07:00Z → peak", isPeakAt(ds940, fri0700Z));
check("deepseek Sat 02:00Z → off-peak (weekends off since Aug 2026)", !isPeakAt(ds940, sat0200Z));

/* ── meta: rule-change gate instant is a candidate for the next flip ─────── */

const gateRule: ProviderRule = {
	id: "gate-test",
	label: "GateTest",
	shortLabel: "GT",
	calendarOffsetMinutes: 480,
	windows: [{ start: "00:00", end: "24:00" }], // always "within window" so only the gate flips it
	peakWeekdays: [1, 2, 3, 4, 5],
	weekendOffPeakFrom: "2026-08-22T16:00:00Z", // = Aug 23 00:00 SGT
};
check("pre-gate Saturday 22:00 SGT is peak (window-only era)",
	isPeakAt(resolveRule(gateRule, ""), new Date("2026-08-22T14:00:00Z")));
check("post-gate Saturday is off-peak",
	!isPeakAt(resolveRule(gateRule, ""), new Date("2026-08-23T04:00:00Z")));
check("pre-gate next change lands exactly on the gate instant",
	nextStateChangeAt(resolveRule(gateRule, ""), new Date("2026-08-22T14:00:00Z"))?.getTime() === Date.parse("2026-08-22T16:00:00Z"));

/* ── render / footer text ────────────────────────────────────────────────── */

check("resolveTimezone: UTC passthrough", resolveTimezone("UTC") === "UTC");
check("resolveTimezone: auto resolves", resolveTimezone("auto") !== "");

check(
	"footer: GLM-5.3 peak ×3 (✗ avoid)",
	statusText(computeStatus(glm53, fri15SGT), "GLM-5.3", fri15SGT, "UTC") === "✗ peak×3 · GLM-5.3 · until 10:00",
);
check(
	"footer: flash off-peak ×0.4 (✓ ok)",
	statusText(computeStatus(glmFlash, campFri1000), "GLM-5.3-Flash", campFri1000, "UTC") ===
		"✓ off-peak ×0.4 · GLM-5.3-Flash · until 06:00",
);
check(
	"footer: flash campaign (🎁 promo)",
	statusText(computeStatus(glmFlash, campFri0230), "GLM-5.3-Flash", campFri0230, "Asia/Singapore") ===
		"🎁 2× quota · GLM-5.3-Flash · until 09:00",
);

// cross-timezone display: classification is on the billing calendar; "until" is
// shown in the user's local timezone, crossing days correctly.
const edtNow = new Date("2026-09-04T03:00:00-04:00"); // = 15:00 SGT, Fri
check(
	"EDT user: peak until 06:00 EDT (same local day)",
	statusText(computeStatus(glm53, edtNow), "GLM-5.3", edtNow, "America/New_York") ===
		"✗ peak×3 · GLM-5.3 · until 06:00",
);
const pdtNow = new Date("2026-09-04T23:30:00-07:00"); // = Sat 14:30 SGT → off-peak (weekend gate)
check(
	"PDT user: off-peak, next change shown as next-day local time",
	statusText(computeStatus(glm53, pdtNow), "GLM-5.3", pdtNow, "America/Los_Angeles") ===
		"✓ off-peak · GLM-5.3 · until Sun 23:00",
);
check("timezone: lowercase IANA accepted", resolveTimezone("asia/singapore") === "asia/singapore");

/* ── rating + per-model report ───────────────────────────────────────────── */

check("rate: off-peak ×0.4 → ok", rateStatus(computeStatus(glmFlash, campFri1000)) === "ok");
check("rate: off-peak ×1 (GLM-5.3) → ok", rateStatus(computeStatus(glm53, fri1359SGT)) === "ok");
check("rate: peak ×1 (DeepSeek) → caution", rateStatus(computeStatus(ds940, fri0200Z)) === "caution");
check("rate: peak ×3 → avoid", rateStatus(computeStatus(glm53, fri15SGT)) === "avoid");
check("rate: campaign → ok", rateStatus(computeStatus(glmFlash, campFri0230)) === "ok");
check("ratingWord: avoid → AVOID", ratingWord(rateStatus(computeStatus(glm53, fri15SGT))) === "AVOID");
check("ratingReason: off-peak ×1 → standard rate (not free)",
	ratingReason(rateStatus(computeStatus(glm53, fri1359SGT)), computeStatus(glm53, fri1359SGT)) === "standard rate");
check("ratingReason: off-peak ×0.4 → cheap rate",
	ratingReason(rateStatus(computeStatus(glmFlash, campFri1000)), computeStatus(glmFlash, campFri1000)) === "cheap rate");
check("concreteModelId: glm-5.3-flash* → glm-5.3-flash", concreteModelId("glm-5.3-flash*") === "glm-5.3-flash");

const report = reportLines(DEFAULT_PROVIDERS, { providerId: "zai", modelId: "glm-5.3-flash" }, campFri0230, "Asia/Singapore");
check("report: header shows time+zone", report[0].includes("Asia/Singapore"));
check(
	"report: per-model lines list state + OK rating",
	report.some((l) => l.includes("GLM-5.3-Flash") && l.includes("OK") && l.includes("2× quota")),
	JSON.stringify(report),
);
check(
	"report: marks the currently selected model with ▶",
	report.some((l) => l.startsWith("▶") && l.includes("GLM-5.3-Flash")),
);
// Campaign period is rendered on the billing calendar (inclusive last day), so
// the UTC-suffixed instants display as Sep 3 → Sep 20 (SGT), not UTC dates.
check(
	"report: campaign period shows billing-calendar dates (Sep 3 → Sep 20)",
	report.some((l) => l.includes("2026-09-03 → 2026-09-20")),
	JSON.stringify(report),
);
// Unified conventions: no free-form "note:" lines; facts derived from structure.
check("report: no free-form 'note:' lines", !report.some((l) => l.includes("note:")), JSON.stringify(report));
check(
	"report: provider line carries source URL",
	report.some((l) => l.includes("DeepSeek (deepseek)") && l.includes("api-docs.deepseek.com")),
	JSON.stringify(report),
);
check(
	"report: DeepSeek weekend gate derived (weekends off since)",
	report.some((l) => l.includes("DeepSeek (deepseek)") && l.includes("weekends off since 2026-08-23")),
	JSON.stringify(report),
);
check(
	"report: campaign details rendered as ' · fact'",
	report.some((l) => l.includes("2× quota · ZCode: 0 quota")),
	JSON.stringify(report),
);
check(
	"report: no duplicated symbol in grid rows (sym column only)",
	!report.some((l) => l.includes("🎁 🎁") || l.includes("✓ ✓") || l.includes("⚡ ⚡")),
	JSON.stringify(report),
);

// A peak with multiplier 0 must never render as "peakfree".
const freePeakProvider: ProviderRule = {
	id: "free-peak",
	label: "FreePeak",
	shortLabel: "FP",
	calendarOffsetMinutes: 0,
	windows: [{ start: "00:00", end: "24:00" }],
	peakWeekdays: [1, 2, 3, 4, 5, 6, 7],
	peakMultiplier: 0,
	offPeakMultiplier: 1,
};
const freePeakSt = computeStatus(resolveRule(freePeakProvider, "m"), new Date("2026-09-04T12:00:00Z"));
const freePeakText = statusText(freePeakSt, "FP", new Date("2026-09-04T12:00:00Z"), "UTC");
check("peak multiplier 0 renders 'peak free' (no 'peakfree')", freePeakText.includes("peak free") && !freePeakText.includes("peakfree"), freePeakText);

/* ── misc sanity ─────────────────────────────────────────────────────────── */

check("shifted: UTC+8 calendar", shifted(fri15SGT, 480).getUTCHours() === 15);
check("GLM has 4 built-in model rules", (glm.models ?? []).length === 4);
check("flash campaigns: 1 built-in", (glmFlash.modelRule?.campaigns ?? []).length === 1);

console.log(failures === 0 ? "\ncore.test: all passed" : `\ncore.test: ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);