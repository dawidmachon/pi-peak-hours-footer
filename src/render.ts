/**
 * Formatting: compact footer/status text, the per-model state report, and the
 * /peak all-models report. Pure string/Date work; native Intl only for
 * timezone-aware display.
 *
 * Footer text format (goal: scan in <1s):
 *   ✓ off-peak ×0.4 · GLM-5.3-Flash · until 14:00
 *   ⚡ peak          · DeepSeek      · until 18:00
 *   ✗ peak×3         · GLM-5.3        · until 18:00
 *   🎁 2× quota       · GLM-5.3-Flash · until 09:00
 *
 * First token = immediate decision signal:
 *   ✓ = OK to use (cheap/off-peak/promo)
 *   ⚡ = CAUTION (peak, or above-standard rate)
 *   ✗ = AVOID (very expensive, e.g. peak ×3)
 *   🎁 = bonus (promotion / quota promo)
 */
import type { Campaign, ModelStatus, ProviderRule } from "./core.ts";
import {
	campaignActiveAt,
	chooseModelRule,
	computeStatus,
	findProvider,
	globMatch,
	isPeakAt,
	parseHm,
	resolveRule,
	shifted,
} from "./core.ts";

/* ── timezone helpers (display only) ─────────────────────────────────────── */

/** "auto" → system zone; "UTC" → UTC; otherwise an IANA name (falls back to auto when unknown). */
export function resolveTimezone(setting: string): string {
	if (!setting || setting === "auto") {
		try {
			return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
		} catch {
			return "UTC";
		}
	}
	if (setting.toUpperCase() === "UTC") return "UTC";
	try {
		new Intl.DateTimeFormat("en", { timeZone: setting });
		return setting;
	} catch {
		return resolveTimezone("auto");
	}
}

/** Offset of a timezone at the given instant, in minutes (east positive). */
export function tzOffsetMinutes(instant: Date, tz: string): number {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
		hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
	}).formatToParts(instant);
	const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "00";
	const asUtc = Date.parse(
		`${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}Z`,
	);
	return Math.round((asUtc - instant.getTime()) / 60_000);
}

function dayKey(instant: Date, tz: string): string {
	return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
}

/** "18:00" or "Sat 18:00" when the target is not today in tz. */
export function fmtWhen(target: Date, now: Date, tz: string): string {
	const clock = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(target);
	if (dayKey(target, tz) === dayKey(now, tz)) return clock;
	const weekday = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short" }).format(target);
	return `${weekday} ${clock}`;
}

function fmtNow(now: Date, tz: string): string {
	return new Intl.DateTimeFormat("en-GB", {
		timeZone: tz, weekday: "short", year: "numeric", month: "short",
		day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
	}).format(now) + ` (${tz})`;
}

/* ── rating (OK / CAUTION / AVOID) ───────────────────────────────────────── */

/** Rating = how OK it is to use the model right now. */
export type Rating = "ok" | "caution" | "avoid";

/** Immediate visual signal. */
export function ratingSymbol(r: Rating): string {
	return r === "ok" ? "✓" : r === "caution" ? "⚡" : "✗";
}

/** Short word for /peak report. */
export function ratingWord(r: Rating): string {
	return r === "ok" ? "OK" : r === "caution" ? "CAUTION" : "AVOID";
}

/** Human-readable reason. */
export function ratingReason(r: Rating, st: ModelStatus): string {
	if (st.kind === "campaign") return "promo active";
	if (r === "ok") return st.multiplier < 1 ? "cheap rate" : "standard rate";
	if (r === "caution") return st.kind === "peak" ? "peak hours" : "higher rate";
	return "expensive rate";
}

/**
 * Rate a model status for immediate-use decision.
 * campaign → ok (bonus)
 * off-peak below base rate → ok
 * off-peak at/above base rate → caution (or avoid if very high)
 * peak → caution if ≤1.5× base, avoid if >1.5× (e.g. GLM peak ×3)
 */
export function rateStatus(st: ModelStatus): Rating {
	if (st.kind === "campaign") return "ok";
	if (st.kind === "offpeak") return st.multiplier < 1 ? "ok" : st.multiplier > 1 ? "caution" : "ok";
	return st.multiplier > 1.5 ? "avoid" : st.multiplier < 1 ? "ok" : "caution";
}

/* ── model-level status text (the compact footer line) ─────────────────────── */

/** "×3", "×0.4", "" for 1, "free" for 0. */
export function fmtMultiplier(m: number): string {
	if (!Number.isFinite(m)) return "";
	if (m === 0) return "free";
	if (m === 1) return "";
	return `×${Number(m.toFixed(2)).toString()}`;
}

/** State word with multiplier, e.g. "peak×3", "off-peak ×0.4", "off-peak free". */
export function stateText(kind: "peak" | "offpeak", multiplier: number): string {
	const m = fmtMultiplier(multiplier);
	if (m === "free") return kind === "peak" ? "peak free" : "off-peak free";
	if (!m) return kind === "peak" ? "peak" : "off-peak";
	return kind === "peak" ? `peak${m}` : `off-peak ${m}`;
}

/** Campaign label or derived multiplier. */
function campaignEffect(st: ModelStatus): string {
	const label = st.campaign?.campaign.label;
	if (label) return label;
	return fmtMultiplier(st.multiplier) || `×${st.multiplier}`; // ×1 visible for neutral campaign
}

/**
 * One compact footer line for the selected model (setStatus, append-only):
 *   ✓ off-peak ×0.4 · GLM-5.3-Flash · until 14:00
 *   ✗ peak×3         · GLM-5.3        · until 18:00
 *   🎁 2× quota       · GLM-5.3-Flash · until 09:00
 *
 * First token = decision (✓ OK / ⚡ CAUTION / ✗ AVOID / 🎁 bonus).
 */
export function statusText(st: ModelStatus, modelLabel: string, now: Date, tz: string): string {
	const r = rateStatus(st);
	const sym = st.kind === "campaign" ? "🎁" : ratingSymbol(r);
	const until = st.until ? ` · until ${fmtWhen(st.until, now, tz)}` : "";

	if (st.kind === "campaign") {
		const effect = campaignEffect(st);
		return `${sym} ${effect} · ${modelLabel}${until}`;
	}

	const state = stateText(st.kind === "peak" ? "peak" : "offpeak", st.multiplier);
	return `${sym} ${state} · ${modelLabel}${until}`;
}

/* ── /peak all-models report ──────────────────────────────────────────────── */

function utcOffsetText(offsetMinutes: number): string {
	const sign = offsetMinutes >= 0 ? "+" : "-";
	const abs = Math.abs(offsetMinutes);
	return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

function weekdayText(rule: ProviderRule): string {
	const wd = rule.peakWeekdays ?? [1, 2, 3, 4, 5];
	if (wd.length === 7) return "every day";
	if (wd.length === 5 && wd.join(",") === "1,2,3,4,5") return "Mon-Fri";
	if (wd.length === 0) return "no fixed days";
	return wd.map((d) => "SMTWTFS"[d - 1]).join("");
}

/** Format a billing-calendar HH:mm as "HH:mm UTC+08" (consistent, no TZ math). */
function fmtBillingClock(calendarMinutes: number, offsetMinutes: number): string {
	const h = String(Math.floor(calendarMinutes / 60)).padStart(2, "0");
	const m = String(calendarMinutes % 60).padStart(2, "0");
	const sign = offsetMinutes >= 0 ? "+" : "-";
	const abs = Math.abs(offsetMinutes);
	const zh = String(Math.floor(abs / 60)).padStart(2, "0");
	const zm = String(abs % 60).padStart(2, "0");
	return `${h}:${m} UTC${sign}${zh}:${zm}`;
}

/** Billing-calendar date (YYYY-MM-DD) for an instant, used for campaign periods. */
function billingDate(ms: number, offsetMinutes: number): string {
	const d = shifted(new Date(ms), offsetMinutes);
	const y = d.getUTCFullYear();
	const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
	const day = String(d.getUTCDate()).padStart(2, "0");
	return `${y}-${mo}-${day}`;
}

function campaignLine(c: Campaign, offsetMinutes: number): string {
	const startMs = Date.parse(c.start);
	const endMs = Date.parse(c.end);
	// Period in billing calendar dates. end is exclusive → last inclusive day is end-1ms.
	const period =
		Number.isFinite(startMs) && Number.isFinite(endMs)
			? `${billingDate(startMs, offsetMinutes)} → ${billingDate(Math.max(startMs, endMs - 1), offsetMinutes)}`
			: `${c.start.slice(0, 10)} → ${c.end.slice(0, 10)}`;
	let when = "";
	if (c.window) {
		when = ` · daily ${fmtBillingClock(parseHm(c.window.start), offsetMinutes)}-${fmtBillingClock(parseHm(c.window.end), offsetMinutes)}`;
		if (c.days && c.days.length > 0 && c.days.length < 7) {
			when += ` · ${c.days.map((d) => "SMTWTFS"[d - 1]).join("")}`;
		}
	}
	const effect = c.label ?? (c.quotaMultiplier === 0 ? "free" : `${c.quotaMultiplier}× quota`);
	const facts = (c.details ?? []).filter((d) => d && d.length > 0).map((d) => ` · ${d}`).join("");
	return `${c.name} (${period}${when}) — ${effect}${facts}`;
}

/** "23:00" as billing minutes; used for alignment. */
function paddedClock(mins: number): string {
	const h = String(Math.floor(mins / 60)).padStart(2, "0");
	const m = String(mins % 60).padStart(2, "0");
	return `${h}:${m}`;
}

/** A fixed-width time window in the billing calendar (for aligned report). */
function billingWindowText(rule: ProviderRule): string {
	if (rule.windows.length === 0) return "—";
	return rule.windows
		.map((w) => `${paddedClock(parseHm(w.start))}-${paddedClock(parseHm(w.end))}`)
		.join(", ");
}

export function concreteModelId(pattern: string): string {
	return pattern.replace(/\*+$/, "");
}

/** State word for /peak line (no leading symbol — the grid has a sym column). */
function stateWord(st: ModelStatus): string {
	if (st.kind === "campaign") return campaignEffect(st);
	return stateText(st.kind === "peak" ? "peak" : "offpeak", st.multiplier);
}

/**
 * All-models /peak report: one aligned grid where every model row shows
 *   symbol  label      state              until (user tz)   rating — reason
 * then per-provider billing windows/campaigns in a consistent block.
 */
export function reportLines(
	rules: ProviderRule[],
	current: { providerId: string; modelId: string } | null,
	now: Date,
	tz: string,
): string[] {
	const lines: string[] = [`Peak/cost now — ${fmtNow(now, tz)}`];
	const currentProvider = current ? findProvider(rules, current.providerId) : null;

	// Build all rows first so we can align the label column.
	interface Row { marker: string; sym: string; label: string; state: string; until: string; rating: string; reason: string; }
	const rows: Row[] = [];
	for (const rule of rules) {
		if (rule.enabled === false) continue;
		const modelRules = rule.models && rule.models.length > 0 ? rule.models.filter((m) => m.enabled !== false) : [];
		const profiles = modelRules.length > 0
			? modelRules.map((m) => ({ id: concreteModelId(m.id), pattern: m.id, label: m.label ?? m.id }))
			: [{ id: rule.id, pattern: rule.id, label: rule.shortLabel }];

		for (const p of profiles) {
			const resolved = resolveRule(rule, p.id);
			const st = computeStatus(resolved, now);
			const rating = rateStatus(st);
			const isCurrent =
				!!current && rule === currentProvider &&
				(current?.providerId === rule.id || (rule.aliases ?? []).includes(current.providerId)) &&
				globMatch(p.pattern, current.modelId);
			const until = st.until ? `until ${fmtWhen(st.until, now, tz)}` : "";
			rows.push({
				marker: isCurrent ? "▶" : " ",
				sym: st.kind === "campaign" ? "🎁" : ratingSymbol(rating),
				label: p.label,
				state: stateWord(st),
				until,
				rating: ratingWord(rating),
				reason: ratingReason(rating, st),
			});
		}
	}

	const labelW = Math.min(20, Math.max(...rows.map((r) => r.label.length), 8));
	// Header note explaining that windows/times are in the USER's timezone.
	lines.push(`  ${"".padEnd(labelW + 1)} state             until (${tz})          rating`);
	lines.push(`  ${"-".repeat(labelW + 1)} ${"-".repeat(16)} ${"-".repeat(22)} ${"-".repeat(22)}`);
	for (const r of rows) {
		lines.push(
			`${r.marker} ${r.sym} ${r.label.padEnd(labelW)} ${r.state.padEnd(16)} ${r.until.padEnd(22)} ${r.rating} — ${r.reason}`,
		);
	}

	// Per-provider blocks: one consistent line with derived facts (no free-form notes).
	for (const rule of rules) {
		if (rule.enabled === false) continue;
		const isCurrent = !!current && rule === currentProvider;
		const windows = billingWindowText(rule);
		const days = weekdayText(rule);
		const offset = rule.calendarOffsetMinutes ?? 0;
		let head = `    ${rule.label} (${rule.id}) · peak ${windows} · ${days} · ${utcOffsetText(offset)}`;
		if (typeof rule.weekendOffPeakFrom === "string") {
			const gateMs = Date.parse(rule.weekendOffPeakFrom);
			if (Number.isFinite(gateMs)) head += ` · weekends off since ${billingDate(gateMs, offset)}`;
		}
		if (rule.source) head += ` · ${rule.source}`;
		lines.push(head);
		for (const c of rule.campaigns ?? []) {
			if (c.model && !(current && rule === currentProvider)) continue;
			const active = campaignActiveAt(offset, c, now);
			const endMs = Date.parse(c.end);
			const ended = Number.isFinite(endMs) && now.getTime() >= endMs;
			const mark = active ? "🎁 ACTIVE" : ended ? "⏳ ENDED" : "          ";
			lines.push(`      ${mark} ${campaignLine(c, offset)}`);
		}
		if (isCurrent && current) {
			const mr = chooseModelRule(rule, current.modelId);
			for (const c of mr?.campaigns ?? []) {
				const active = campaignActiveAt(offset, c, now);
				const endMs = Date.parse(c.end);
				const ended = Number.isFinite(endMs) && now.getTime() >= endMs;
				const mark = active ? "🎁 ACTIVE" : ended ? "⏳ ENDED" : "          ";
				lines.push(`      ${mark} ${campaignLine(c, offset)}`);
			}
		}
	}
	return lines;
}

/** Is a provider currently in peak (provider-level windows)? Used by tests/tools. */
export function providerPeakAt(rule: ProviderRule, now: Date): boolean {
	return isPeakAt(resolveRule(rule, ""), now);
}
