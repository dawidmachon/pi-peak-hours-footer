/**
 * Pure peak/off-peak + campaign logic. No pi imports, no fs — runs anywhere,
 * tested directly.
 *
 * Billing-calendar trick: a provider's "wall clock" is a fixed UTC offset
 * (`calendarOffsetMinutes`). All window/weekday math is done on that calendar
 * (the instant shifted by the offset, then read with UTC getters), never on
 * the user's local time. This mirrors how vendors bill: GLM and DeepSeek both
 * bill on UTC+8, and e.g. "14:00–18:00 SGT peak" must be evaluated on the
 * 08:00-shifted clock, not on UTC (the two calendars disagree on weekdays).
 *
 * Campaigns are time-bounded rule overrides (promotions) that are evaluated
 * automatically against the system clock, so they activate/deactivate with no
 * manual steps. A campaign may restrict itself to a daily window in the
 * billing calendar (including overnight windows such as 23:00–09:00) and to
 * a set of weekdays; an omitted `days` list means every day (weekends and
 * public holidays included, as vendors like Z.AI state for their campaigns).
 */

export interface TimeWindow {
	/** Billing-calendar wall-clock start, "HH:mm" (inclusive). */
	start: string;
	/** Billing-calendar wall-clock end, "HH:mm" (exclusive). May wrap past midnight ("23:00"→"09:00"). */
	end: string;
}

export interface Campaign {
	/** Unique name. Also the merge key when patching built-in campaigns from config. */
	name: string;
	/** Inclusive start instant (ISO 8601, e.g. "2026-09-03T00:00:00+08:00"). */
	start: string;
	/** Exclusive end instant (ISO 8601). */
	end: string;
	/**
	 * Optional daily window in billing-calendar wall time. Overnight windows
	 * (end <= start) are supported. Omitted = active around the clock within
	 * the period.
	 */
	window?: TimeWindow;
	/** ISO weekdays (1=Mon..7=Sun) the daily window applies to. Omitted/empty = every day. */
	days?: number[];
	/** Quota burn multiplier while active: 2 = double quota, 0 = free. */
	quotaMultiplier: number;
	/** Model id/glob this campaign applies to (provider-level campaigns only). */
	model?: string;
	/** Optional short footer label ("2× quota"). */
	label?: string;
	/** Optional short fact fragments for the /peak report (rendered as " · fact"). No free-form prose. */
	details?: string[];
	/** Config-only: true removes a built-in campaign with the same name. */
	disabled?: boolean;
	/** Config-only: true fully replaces the built-in campaign with the same name. */
	replace?: boolean;
}

export interface ModelRule {
	/** Model id or glob pattern (`*` wildcard), e.g. "glm-5.3" or "glm-5.3-flash*". Exact ids win. */
	id: string;
	/** Display label, e.g. "GLM-5.3-Flash". Falls back to the provider label. */
	label?: string;
	/** Quota burn multiplier during peak (1 = standard rate). */
	peakMultiplier?: number;
	/** Quota burn multiplier off-peak (0.5 = half price). */
	offPeakMultiplier?: number;
	/** Per-model peak windows (rare; usually inherited from the provider). */
	windows?: TimeWindow[];
	/** Per-model campaigns. */
	campaigns?: Campaign[];
	/** Config-only: true removes a built-in model rule with the same id. */
	enabled?: boolean;
	/** Config-only: true fully replaces the built-in model rule with the same id. */
	replace?: boolean;
}

export interface ProviderRule {
	/** pi provider id (e.g. "zai", "deepseek"). May be a glob. */
	id: string;
	/** Extra provider ids that should match this rule (e.g. "glm", "zhipu" for zai). */
	aliases?: string[];
	/** Display name. */
	label: string;
	/** Short display name, used as a fallback model label. */
	shortLabel: string;
	/** Billing calendar as a fixed UTC offset in minutes (UTC+8 → 480). Omit on patch entries; required for new providers (0 = UTC). */
	calendarOffsetMinutes?: number;
	/** Peak windows in billing-calendar wall time. */
	windows: TimeWindow[];
	/** ISO weekdays (1=Mon..7=Sun) peak windows run. Default [1..5]. */
	peakWeekdays?: number[];
	/** Quota burn multiplier during peak (1 = standard credit rate). */
	peakMultiplier?: number;
	/** Quota burn multiplier off-peak (0.5 = 50% of the standard rate). */
	offPeakMultiplier?: number;
	/**
	 * Optional instant (ISO) from which non-peak weekdays are entirely
	 * off-peak. null/undefined = the weekday axis always applies. Before the
	 * gate instant (when set) the weekday axis does not apply at all
	 * (vendor-specific historical billing quirk, see DeepSeek).
	 */
	weekendOffPeakFrom?: string | null;
	/** Provider-level campaigns; each may carry a `model` glob. */
	campaigns?: Campaign[];
	/** Per-model overrides. */
	models?: ModelRule[];
	/** Config-only: true removes a built-in provider with the same id. */
	enabled?: boolean;
	/** Config-only: true fully replaces the built-in provider instead of patching it. */
	replace?: boolean;
	/** Source URL for the published rules. */
	source?: string;
}

/* ── small helpers ───────────────────────────────────────────────────────── */

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** "HH:mm" (or "H:mm") → minutes since midnight. Tolerant of hand-edited configs. */
export function parseHm(value: string): number {
	const [h, m] = value.split(":").map(Number);
	return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

/** Instant shifted onto the billing calendar; read with UTC getters. */
export function shifted(instant: Date | number, offsetMinutes: number): Date {
	return new Date((typeof instant === "number" ? instant : instant.getTime()) + offsetMinutes * MINUTE_MS);
}

/** Billing-calendar minutes-of-day (fractional seconds) for a shifted Date. */
function minutesOfDay(d: Date): number {
	return d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;
}

/** ISO weekday (1=Mon..7=Sun) of a UTC-based Date. */
export function isoWeekday(d: Date): number {
	const wd = d.getUTCDay();
	return wd === 0 ? 7 : wd;
}

/** Window containment in billing-calendar minutes; supports overnight (end <= start). */
export function inWindow(w: TimeWindow, minutes: number): boolean {
	const start = parseHm(w.start);
	const end = parseHm(w.end);
	if (end > start) return minutes >= start && minutes < end;
	return minutes >= start || minutes < end; // wraps past midnight
}

/** Minimal glob matching supporting `*` (any run of chars). Exact matches short-circuit. */
export function globMatch(pattern: string, value: string): boolean {
	if (pattern === value) return true;
	if (!pattern.includes("*")) return false;
	const parts = pattern.split("*");
	let rest = value;
	if (parts[0] !== "") {
		if (!rest.startsWith(parts[0])) return false;
		rest = rest.slice(parts[0].length);
	}
	for (let i = 1; i < parts.length - 1; i++) {
		const idx = rest.indexOf(parts[i]);
		if (idx === -1) return false;
		rest = rest.slice(idx + parts[i].length);
	}
	const last = parts[parts.length - 1];
	if (last !== "" && !rest.endsWith(last)) return false;
	return true;
}

/** Does `providerId` match this rule's id or any alias? */
export function providerMatches(rule: ProviderRule, providerId: string): boolean {
	return globMatch(rule.id, providerId) || (rule.aliases ?? []).some((a) => globMatch(a, providerId));
}

/* ── rule resolution ─────────────────────────────────────────────────────── */

/** Best model rule for `modelId`: exact id first, then most-specific (longest) glob. */
export function chooseModelRule(provider: ProviderRule, modelId: string): ModelRule | null {
	let best: ModelRule | null = null;
	let bestScore = -1;
	for (const m of provider.models ?? []) {
		if (m.id === modelId) return m; // exact id wins outright
		if (globMatch(m.id, modelId)) {
			const score = m.id.length;
			if (score > bestScore) {
				bestScore = score;
				best = m;
			}
		}
	}
	return best;
}

/** First enabled provider rule matching `providerId` (exact/alias first, then glob). */
export function findProvider(rules: ProviderRule[], providerId: string): ProviderRule | undefined {
	const enabled = rules.filter((r) => r.enabled !== false);
	for (const r of enabled) if (r.id === providerId || (r.aliases ?? []).includes(providerId)) return r;
	for (const r of enabled) if (providerMatches(r, providerId)) return r;
	return undefined;
}

export interface ResolvedRule {
	provider: ProviderRule;
	/** Matched model rule, or null when only provider-level rules apply. */
	modelRule: ModelRule | null;
	/** The actual model id this rule was resolved for. */
	modelId: string;
	/** Effective billing-calendar offset (provider offset, default 0 = UTC). */
	offsetMinutes: number;
	/** Effective peak windows (model override or provider). */
	windows: TimeWindow[];
	/** Effective peak weekdays. */
	peakWeekdays: number[];
	/** Effective quota burn during peak. */
	peakMultiplier: number;
	/** Effective quota burn during off-peak. */
	offPeakMultiplier: number;
}

export function resolveRule(provider: ProviderRule, modelId: string): ResolvedRule {
	const modelRule = chooseModelRule(provider, modelId);
	return {
		provider,
		modelRule,
		modelId,
		offsetMinutes: provider.calendarOffsetMinutes ?? 0,
		windows: modelRule?.windows && modelRule.windows.length > 0 ? modelRule.windows : provider.windows,
		peakWeekdays: provider.peakWeekdays && provider.peakWeekdays.length > 0 ? provider.peakWeekdays : [1, 2, 3, 4, 5],
		peakMultiplier: modelRule?.peakMultiplier ?? provider.peakMultiplier ?? 1,
		offPeakMultiplier: modelRule?.offPeakMultiplier ?? provider.offPeakMultiplier ?? 1,
	};
}

/* ── peak/off-peak classification ────────────────────────────────────────── */

/**
 * Is `instant` inside a peak window? Weekday axis is read on the billing
 * calendar (calendarOffsetMinutes), never on UTC. The `weekendOffPeakFrom`
 * gate is evaluated on the instant being classified, never on "now", so
 * historical instants bill the way they actually were billed.
 */
export function isPeakAt(resolved: ResolvedRule, instant: Date): boolean {
	const local = shifted(instant, resolved.offsetMinutes);
	const weekday = isoWeekday(local);
	const gate = resolved.provider.weekendOffPeakFrom;
	const gateMs = typeof gate === "string" ? Date.parse(gate) : NaN;
	const gateSet = Number.isFinite(gateMs);
	if (!gateSet) {
		if (!resolved.peakWeekdays.includes(weekday)) return false;
	} else if (instant.getTime() >= gateMs && !resolved.peakWeekdays.includes(weekday)) {
		return false;
	}
	return resolved.windows.some((w) => inWindow(w, minutesOfDay(local)));
}

/* ── campaigns ───────────────────────────────────────────────────────────── */

/** All campaigns that can affect `modelId`: provider-level (filtered by glob) then model-level. */
export function campaignsFor(provider: ProviderRule, modelId: string): Campaign[] {
	const out: Campaign[] = [];
	for (const c of provider.campaigns ?? []) {
		if (!c.model || globMatch(c.model, modelId)) out.push(c);
	}
	const mr = chooseModelRule(provider, modelId);
	for (const c of mr?.campaigns ?? []) out.push(c);
	return out;
}

/** Is `instant` inside one specific campaign? `offsetMinutes` is the billing-calendar offset. */
export function campaignActiveAt(offsetMinutes: number, campaign: Campaign, instant: Date): boolean {
	const t = instant.getTime();
	const startMs = Date.parse(campaign.start);
	const endMs = Date.parse(campaign.end);
	if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return false;
	if (t < startMs || t >= endMs) return false;
	if (!campaign.window) return true;
	const local = shifted(instant, offsetMinutes);
	if (campaign.days && campaign.days.length > 0 && !campaign.days.includes(isoWeekday(local))) return false;
	return inWindow(campaign.window, minutesOfDay(local));
}

export interface ActiveCampaign {
	campaign: Campaign;
	/** When this campaign stops being active (period end or daily-window end). */
	until: Date | null;
}

/** First currently-active campaign affecting `modelId`, or null (no `until` scan). */
function firstActiveCampaign(resolved: ResolvedRule, instant: Date): Campaign | null {
	for (const c of campaignsFor(resolved.provider, resolved.modelId)) {
		if (campaignActiveAt(resolved.offsetMinutes, c, instant)) return c;
	}
	return null;
}

/** First currently-active campaign affecting `modelId`, with its deactivation instant. */
export function activeCampaignAt(resolved: ResolvedRule, instant: Date): ActiveCampaign | null {
	const c = firstActiveCampaign(resolved, instant);
	if (!c) return null;
	return { campaign: c, until: nextCampaignChangeAt(resolved.provider, c, instant) };
}

/**
 * Earliest instant > `instant` at which this campaign's active state flips
 * (period start/end, plus daily-window edges within the period). Returns null
 * when the state never flips within the period.
 */
export function nextCampaignChangeAt(provider: ProviderRule, campaign: Campaign, instant: Date): Date | null {
	const startMs = Date.parse(campaign.start);
	const endMs = Date.parse(campaign.end);
	if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
	const t = instant.getTime();
	if (t >= endMs) return null;
	const activeNow = campaignActiveAt(provider.calendarOffsetMinutes ?? 0, campaign, instant);

	const candidates = new Set<number>([startMs, endMs]);
	if (campaign.window) {
		const offset = provider.calendarOffsetMinutes ?? 0;
		const from = Math.max(t, startMs);
		const fromLocal = shifted(from, offset);
		const horizonMs = Math.min(endMs, t + 40 * DAY_MS); // safety bound
		for (let day = 0; day <= 45; day++) {
			const dayStartUtc = Date.UTC(
				fromLocal.getUTCFullYear(),
				fromLocal.getUTCMonth(),
				fromLocal.getUTCDate() + day,
			);
			for (const edgeMin of [parseHm(campaign.window.start), parseHm(campaign.window.end), 0]) {
				const candMs = dayStartUtc + edgeMin * MINUTE_MS - offset * MINUTE_MS;
				if (candMs > from && candMs < endMs && candMs <= horizonMs) candidates.add(candMs);
			}
			if (dayStartUtc + DAY_MS - offset * MINUTE_MS >= endMs) break;
		}
	}

	for (const ms of [...candidates].sort((a, b) => a - b)) {
		if (ms <= t) continue;
		if (campaignActiveAt(provider.calendarOffsetMinutes ?? 0, campaign, new Date(ms)) !== activeNow) return new Date(ms);
	}
	return null;
}

/* ── combined status ─────────────────────────────────────────────────────── */

export type StatusKind = "campaign" | "peak" | "offpeak";

export interface ModelStatus {
	kind: StatusKind;
	/** Effective quota/cost multiplier. */
	multiplier: number;
	/** Short display label, e.g. "GLM-5.3-Flash". */
	label: string;
	/** Earliest later instant this status changes, or null when none found in the horizon. */
	until: Date | null;
	/** Present when kind === "campaign". */
	campaign?: ActiveCampaign;
}

/** Display label: model label → model id (when a model rule matched) → provider short label. */
export function displayLabel(resolved: ResolvedRule): string {
	if (resolved.modelRule) return resolved.modelRule.label ?? resolved.modelRule.id;
	return resolved.provider.shortLabel;
}

/** Compact key identifying the display state at an instant (used for change detection). */
function statusKey(resolved: ResolvedRule, instant: Date): string {
	const camp = firstActiveCampaign(resolved, instant);
	if (camp) return `campaign:${camp.name}:${camp.quotaMultiplier}`;
	const peak = isPeakAt(resolved, instant);
	return `${peak ? "peak" : "offpeak"}:${peak ? resolved.peakMultiplier : resolved.offPeakMultiplier}`;
}

/**
 * Earliest instant > `now` at which the display status changes (peak↔off-peak
 * window flips, weekend boundaries, OR campaign start/end). Scans window edges
 * and local midnights for `horizonDays`, plus every campaign's boundaries.
 */
export function nextStateChangeAt(resolved: ResolvedRule, now: Date, horizonDays = 14): Date | null {
	const base = statusKey(resolved, now);
	const candidates = new Set<number>();
	const offset = resolved.offsetMinutes;

	const edges = new Set<number>([0]); // local midnight: the billing-calendar day boundary
	for (const w of resolved.windows) {
		edges.add(parseHm(w.start));
		edges.add(parseHm(w.end));
	}
	const startLocal = shifted(now, offset);
	// A future rule-change gate instant can flip the phase on its own (e.g. the
	// day a provider starts treating weekends as fully off-peak).
	const gate = resolved.provider.weekendOffPeakFrom;
	if (typeof gate === "string") {
		const gateMs = Date.parse(gate);
		if (Number.isFinite(gateMs)) candidates.add(gateMs);
	}
	for (let day = 0; day <= horizonDays; day++) {
		const dayStartUtc = Date.UTC(
			startLocal.getUTCFullYear(),
			startLocal.getUTCMonth(),
			startLocal.getUTCDate() + day,
		);
		for (const e of edges) {
			const candMs = dayStartUtc + e * MINUTE_MS - offset * MINUTE_MS;
			if (candMs > now.getTime()) candidates.add(candMs);
		}
	}
	for (const campaign of campaignsFor(resolved.provider, resolved.modelId)) {
		const ch = nextCampaignChangeAt(resolved.provider, campaign, now);
		if (ch) candidates.add(ch.getTime());
	}

	for (const ms of [...candidates].sort((a, b) => a - b)) {
		if (statusKey(resolved, new Date(ms)) !== base) return new Date(ms);
	}
	return null;
}

/** Full status (campaign-aware) for a resolved rule at `now`. */
export function computeStatus(resolved: ResolvedRule, now: Date): ModelStatus {
	const camp = activeCampaignAt(resolved, now);
	if (camp) {
		return {
			kind: "campaign",
			multiplier: camp.campaign.quotaMultiplier,
			label: displayLabel(resolved), // the MODEL label; the campaign effect lives on campaign.label
			until: camp.until,
			campaign: camp,
		};
	}
	const peak = isPeakAt(resolved, now);
	return {
		kind: peak ? "peak" : "offpeak",
		multiplier: peak ? resolved.peakMultiplier : resolved.offPeakMultiplier,
		label: displayLabel(resolved),
		until: nextStateChangeAt(resolved, now),
	};
}