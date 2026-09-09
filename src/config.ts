/**
 * Config loading for the peak-hours indicator.
 *
 * Source of truth for rules is `~/.pi/agent/peak-hours.json` (or
 * `$PI_CODING_AGENT_DIR/agent/peak-hours.json`; override with the
 * `PEAK_HOURS_CONFIG` env var for tests / custom setups). The file is a JSON
 * data file — adding a provider, model, or promotion requires editing the
 * file, never rebuilding the extension.
 *
 * Merge semantics (so the file stays small and expandable):
 * - Providers patch built-ins by id: scalars/arrays override, `models` merge
 *   by model id, `campaigns` merge by campaign name.
 * - `enabled: false` removes a built-in provider/model; `disabled: true`
 *   removes a built-in campaign; `replace: true` swaps the whole entry
 *   instead of patching it.
 * - A provider id that isn't built-in is simply added.
 *
 * Invalid entries are skipped (a malformed line never breaks the extension).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Campaign, ModelRule, ProviderRule, TimeWindow } from "./core.ts";
import { parseHm } from "./core.ts";
import { DEFAULT_PROVIDERS } from "./defaults.ts";

export interface PeakHoursConfig {
	/** Billing/wall-clock timezone for RULES. "auto" (system zone) | "UTC" | IANA. Default "auto". */
	timezone: string;
	/** User-perspective display timezone for "until" times. "auto" = system zone (default). */
	displayTimezone: string;
	/** "always": show peak AND off-peak; "peak": only show while peak/campaign active. */
	show: "peak" | "always";
	/** Footer refresh interval in seconds. */
	tickSeconds: number;
	/** Active provider rules (built-ins + file patches/additions). */
	providers: ProviderRule[];
}

export const DEFAULTS: PeakHoursConfig = {
	timezone: "auto",
	displayTimezone: "auto",
	show: "always",
	tickSeconds: 30,
	providers: [...DEFAULT_PROVIDERS],
};

/* ── path ────────────────────────────────────────────────────────────────── */

function expandTilde(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

export function configPath(): string {
	const env = process.env.PEAK_HOURS_CONFIG;
	if (env) return env;
	const base = process.env.PI_CODING_AGENT_DIR
		? expandTilde(process.env.PI_CODING_AGENT_DIR)
		: join(homedir(), ".pi", "agent");
	return join(base, "peak-hours.json");
}

/* ── tolerant coercion ───────────────────────────────────────────────────── */

function isObj(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
	return typeof v === "string" && v !== "" ? v : undefined;
}

function num(v: unknown): number | undefined {
	if (typeof v === "number" && Number.isFinite(v)) return v;
	if (typeof v === "string" && v !== "" && Number.isFinite(Number(v))) return Number(v);
	return undefined;
}

function bool(v: unknown): boolean | undefined {
	return typeof v === "boolean" ? v : undefined;
}

function arr(v: unknown): unknown[] | undefined {
	return Array.isArray(v) ? v : undefined;
}

/* ── sanitizers (shape-only; unknown fields ignored) ─────────────────────── */

function sanitizeWindow(v: unknown): TimeWindow | null {
	if (!isObj(v)) return null;
	const start = str(v.start);
	const end = str(v.end);
	if (!start || !end || parseHm(start) === parseHm(end)) return null;
	return { start, end };
}

function sanitizeWindows(v: unknown): TimeWindow[] | undefined {
	const list = arr(v);
	if (!list) return undefined;
	const out = list.map(sanitizeWindow).filter((w): w is TimeWindow => w !== null);
	return out.length > 0 ? out : undefined;
}

function sanitizeCampaign(v: unknown): Campaign | null {
	if (!isObj(v)) return null;
	const name = str(v.name);
	if (!name) return null;
	// A `disabled: true` stub only needs the name — it removes a built-in campaign.
	// The placeholder fields are never surfaced: mergeCampaigns deletes disabled
	// entries before merging, so they exist only to satisfy the Campaign type.
	const disabled = bool(v.disabled);
	if (disabled === true) return { name, disabled: true, start: "", end: "", quotaMultiplier: 0 };
	const start = str(v.start);
	const end = str(v.end);
	if (!start || !end) return null;
	if (!Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end))) return null;
	const quotaMultiplier = num(v.quotaMultiplier);
	if (quotaMultiplier === undefined) return null;

	const out: Campaign = { name, start, end, quotaMultiplier };
	const model = str(v.model);
	if (model) out.model = model;
	const win = sanitizeWindow(v.window);
	if (win) out.window = win;
	const days = arr(v.days)?.map((d) => num(d)).filter((d): d is number => d !== undefined);
	if (days && days.length > 0) out.days = [...new Set(days.map((d) => Math.round(d)))].filter((d) => d >= 1 && d <= 7).sort((a, b) => a - b);
	const label = str(v.label);
	if (label) out.label = label;
	const details = arr(v.details)?.map(str).filter((s): s is string => s !== undefined);
	if (details && details.length > 0) out.details = details;
	if (disabled !== undefined) out.disabled = disabled;
	const replace = bool(v.replace);
	if (replace !== undefined) out.replace = replace;
	return out;
}

function sanitizeModel(v: unknown): ModelRule | null {
	if (!isObj(v)) return null;
	const id = str(v.id);
	if (!id) return null;
	const out: ModelRule = { id };
	const label = str(v.label);
	if (label) out.label = label;
	const peak = num(v.peakMultiplier);
	if (peak !== undefined) out.peakMultiplier = peak;
	const offPeak = num(v.offPeakMultiplier);
	if (offPeak !== undefined) out.offPeakMultiplier = offPeak;
	const windows = sanitizeWindows(v.windows);
	if (windows) out.windows = windows;
	const campaigns = arr(v.campaigns)?.map(sanitizeCampaign).filter((c): c is Campaign => c !== null);
	if (campaigns && campaigns.length > 0) out.campaigns = campaigns;
	const enabled = bool(v.enabled);
	if (enabled !== undefined) out.enabled = enabled;
	const replace = bool(v.replace);
	if (replace !== undefined) out.replace = replace;
	return out;
}

function sanitizeProvider(v: unknown): ProviderRule | null {
	if (!isObj(v)) return null;
	const id = str(v.id);
	if (!id) return null;
	const out: ProviderRule = { id, label: str(v.label) ?? id, shortLabel: str(v.shortLabel) ?? id, windows: [] };
	const offset = num(v.calendarOffsetMinutes);
	if (offset !== undefined) out.calendarOffsetMinutes = Math.round(offset);
	const windows = sanitizeWindows(v.windows);
	if (windows) out.windows = windows;
	const weekdays = arr(v.peakWeekdays)?.map((d) => num(d)).filter((d): d is number => d !== undefined);
	if (weekdays && weekdays.length > 0) out.peakWeekdays = [...new Set(weekdays.map((d) => Math.round(d)))].filter((d) => d >= 1 && d <= 7).sort((a, b) => a - b);
	const peak = num(v.peakMultiplier);
	if (peak !== undefined) out.peakMultiplier = peak;
	const offPeak = num(v.offPeakMultiplier);
	if (offPeak !== undefined) out.offPeakMultiplier = offPeak;
	if (v.weekendOffPeakFrom === null || v.weekendOffPeakFrom === undefined) {
		out.weekendOffPeakFrom = v.weekendOffPeakFrom === null ? null : undefined;
	} else {
		const gate = str(v.weekendOffPeakFrom);
		if (gate && Number.isFinite(Date.parse(gate))) out.weekendOffPeakFrom = gate;
	}
	const aliases = arr(v.aliases)?.map(str).filter((s): s is string => s !== undefined);
	if (aliases && aliases.length > 0) out.aliases = aliases;
	const campaigns = arr(v.campaigns)?.map(sanitizeCampaign).filter((c): c is Campaign => c !== null);
	if (campaigns && campaigns.length > 0) out.campaigns = campaigns;
	const models = arr(v.models)?.map(sanitizeModel).filter((m): m is ModelRule => m !== null);
	if (models && models.length > 0) out.models = models;
	const enabled = bool(v.enabled);
	if (enabled !== undefined) out.enabled = enabled;
	const replace = bool(v.replace);
	if (replace !== undefined) out.replace = replace;
	const source = str(v.source);
	if (source) out.source = source;
	return out;
}

/* ── merge (built-ins + file) ────────────────────────────────────────────── */

function pick<T>(...vals: (T | undefined)[]): T | undefined {
	for (const v of vals) if (v !== undefined) return v;
	return undefined;
}

function mergeCampaign(base: Campaign | undefined, patch: Campaign): Campaign {
	if (!base || patch.replace) return patch;
	return {
		name: patch.name,
		start: patch.start,
		end: patch.end,
		quotaMultiplier: patch.quotaMultiplier,
		window: patch.window ?? base.window,
		days: patch.days ?? base.days,
		model: pick(patch.model, base.model),
		label: pick(patch.label, base.label),
		details: patch.details ?? base.details,
		disabled: pick(patch.disabled, base.disabled),
		replace: pick(patch.replace, base.replace),
	};
}

function mergeCampaigns(base: Campaign[] | undefined, patch: Campaign[] | undefined): Campaign[] {
	const byName = new Map<string, Campaign>();
	for (const c of base ?? []) byName.set(c.name, c);
	for (const c of patch ?? []) {
		if (c.disabled === true) {
			byName.delete(c.name);
			continue;
		}
		byName.set(c.name, mergeCampaign(byName.get(c.name), c));
	}
	return [...byName.values()];
}

function mergeModel(base: ModelRule | undefined, patch: ModelRule): ModelRule {
	if (!base || patch.replace) return patch;
	return {
		id: patch.id,
		label: pick(patch.label, base.label),
		peakMultiplier: pick(patch.peakMultiplier, base.peakMultiplier),
		offPeakMultiplier: pick(patch.offPeakMultiplier, base.offPeakMultiplier),
		windows: patch.windows ?? base.windows,
		campaigns: mergeCampaigns(base.campaigns, patch.campaigns),
		enabled: pick(patch.enabled, base.enabled),
		replace: pick(patch.replace, base.replace),
	};
}

function mergeModels(base: ModelRule[] | undefined, patch: ModelRule[] | undefined): ModelRule[] {
	const byId = new Map<string, ModelRule>();
	for (const m of base ?? []) byId.set(m.id, m);
	for (const m of patch ?? []) {
		if (m.enabled === false) {
			byId.delete(m.id);
			continue;
		}
		byId.set(m.id, mergeModel(byId.get(m.id), m));
	}
	return [...byId.values()];
}

function mergeProvider(base: ProviderRule | undefined, patch: ProviderRule): ProviderRule {
	if (!base || patch.replace) return patch;
	// A brand-new provider must define windows; warn otherwise (never peak).
	if (!base && patch.windows.length === 0) {
		console.warn(`[peak-hours] provider "${patch.id}" has no windows — it will never be peak.`);
	}
	return {
		id: patch.id,
		aliases: patch.aliases ?? base.aliases,
		label: patch.label ?? base.label,
		shortLabel: patch.shortLabel ?? base.shortLabel,
		calendarOffsetMinutes: patch.calendarOffsetMinutes ?? base.calendarOffsetMinutes ?? 0,
		windows: patch.windows.length > 0 ? patch.windows : base.windows,
		peakWeekdays: patch.peakWeekdays ?? base.peakWeekdays,
		peakMultiplier: pick(patch.peakMultiplier, base.peakMultiplier),
		offPeakMultiplier: pick(patch.offPeakMultiplier, base.offPeakMultiplier),
		weekendOffPeakFrom: pick(patch.weekendOffPeakFrom, base.weekendOffPeakFrom),
		campaigns: mergeCampaigns(base.campaigns, patch.campaigns),
		models: mergeModels(base.models, patch.models),
		enabled: pick(patch.enabled, base.enabled),
		replace: pick(patch.replace, base.replace),
		source: patch.source ?? base.source,
	};
}

function mergeProviders(builtIn: ProviderRule[], file: unknown[]): ProviderRule[] {
	const byId = new Map<string, ProviderRule>();
	for (const p of builtIn) byId.set(p.id, p);
	for (const entry of file) {
		const patch = sanitizeProvider(entry);
		if (!patch) continue;
		if (patch.enabled === false) {
			byId.delete(patch.id);
			continue;
		}
		byId.set(patch.id, mergeProvider(byId.get(patch.id), patch));
	}
	return [...byId.values()];
}

/* ── entry point ─────────────────────────────────────────────────────────── */

/**
 * Load config: defaults, then merge the JSON file (if present). Never throws;
 * a missing/unreadable file yields defaults, a malformed file yields
 * defaults + a console warning.
 */
export function loadConfig(): PeakHoursConfig {
	const cfg: PeakHoursConfig = { ...DEFAULTS, providers: [...DEFAULTS.providers] };

	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(configPath(), "utf8"));
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code;
		if (code !== "ENOENT") console.warn(`[peak-hours] cannot read ${configPath()}: ${(err as Error).message}`);
		return cfg;
	}
	if (!isObj(raw)) {
		console.warn(`[peak-hours] ${configPath()} is not a JSON object — using defaults.`);
		return cfg;
	}

	const tz = str(raw.timezone);
	const displayTz = str(raw.displayTimezone);
	if (tz) cfg.timezone = tz;
	if (displayTz) {
		cfg.displayTimezone = displayTz;
	} else if (tz) {
		// Legacy: `timezone` now only drives display when `displayTimezone` is unset.
		cfg.displayTimezone = tz;
	}
	if (raw.show === "peak") cfg.show = "peak";

	const tick = num(raw.tickSeconds);
	if (tick !== undefined && tick >= 5 && tick <= 3600) cfg.tickSeconds = Math.round(tick);
	const providers = arr(raw.providers);
	if (providers) cfg.providers = mergeProviders(cfg.providers, providers);
	return cfg;
}