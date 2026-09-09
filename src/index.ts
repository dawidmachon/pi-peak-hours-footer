/**
 * pi-peak-hours-footer — peak/off-peak billing indicator for the pi FOOTER.
 *
 * Uses `ctx.ui.setStatus("peak-hours", text)` — a keyed status line: pi
 * concatenates all extensions' keyed statuses, so this coexists with any
 * other extension without conflict.
 *
 * Shows a compact line when the selected model belongs to a configured provider:
 *   ✓ off-peak · GLM-5.3-Flash · ×0.4
 *   ⚡ peak×3   · GLM-5.3       · until 18:00
 *   🎁 2× quota · GLM-5.3-Flash · until 09:00
 *
 * The first token is the decision signal: ✓ OK / ⚡ CAUTION / ✗ AVOID / 🎁 bonus.
 *
 * Rules and promotions are DATA read from `~/.pi/agent/peak-hours.json`
 * (merged over compiled-in defaults) — adding a provider/model/campaign is a
 * config edit, never a rebuild. See README.md and peak-hours.example.json.
 *
 * Commands:
 *   /peak   — all-tracked-models report (with rating for each)
 *   /ph     — same report (shorter alias)
 *
 * Wiring:
 * - session_start: set initial status + start 30s ticker
 * - model_select:  re-evaluate for new model
 * - session_shutdown: clear status + stop ticker
 * - /reload: recreates extension, re-reads config
 */
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { computeStatus, findProvider, resolveRule, type ModelStatus } from "./core.ts";
import { rateStatus, reportLines, resolveTimezone, statusText } from "./render.ts";

const STATUS_KEY = "peak-hours";

export default function piPeakHoursFooter(pi: ExtensionAPI): void {
	const cfg = loadConfig(); // read once at load; /reload recreates the extension
	const rules = cfg.providers;
	const displayTz = resolveTimezone(cfg.displayTimezone); // cached per load

	let timer: ReturnType<typeof setInterval> | null = null;
	let lastCtx: ExtensionContext | null = null;

	const clearStatus = (): void => {
		try {
			lastCtx?.ui.setStatus(STATUS_KEY, undefined);
		} catch { /* UI already torn down */ }
	};

	/** Theme-aware color for a status (matches the user's active theme). */
	const themeColor = (st: ModelStatus): "success" | "warning" | "error" => {
		const r = rateStatus(st);
		if (st.kind === "campaign") return "success";
		return r === "ok" ? "success" : r === "caution" ? "warning" : "error";
	};

	/** Refresh status for the current model. */
	const refresh = (): void => {
		const ctx = lastCtx;
		if (!ctx) return;

		const model = ctx.model;
		if (!model) {
			clearStatus();
			return;
		}

		const provider = findProvider(rules, model.provider);
		if (!provider) {
			clearStatus(); // not a tracked provider
			return;
		}

		try {
			const now = new Date(); // single instant for classification + display
			const st = computeStatus(resolveRule(provider, model.id), now);
			const label = model.name ?? model.id;
			const text = statusText(st, label, now, displayTz);
			// hide off-peak when show=peak
			if (st.kind === "offpeak" && cfg.show === "peak") {
				clearStatus();
				return;
			}
			// Color with the user's theme (same palette/size as the rest of the footer)
			const color = ctx.ui?.theme?.fg ? ctx.ui.theme.fg(themeColor(st), text) : text;
			ctx.ui.setStatus(STATUS_KEY, color);
		} catch (err) {
			console.error("[peak-hours] refresh failed:", err);
			clearStatus();
		}
	};

	pi.on("session_start", (_event, ctx) => {
		lastCtx = ctx;
		refresh();
		if (!timer) {
			timer = setInterval(refresh, cfg.tickSeconds * 1000);
			timer.unref(); // never keep the process alive just for us
		}
	});

	pi.on("model_select", (_event, ctx) => {
		lastCtx = ctx;
		refresh();
	});

	pi.on("session_shutdown", () => {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
		clearStatus();
		lastCtx = null;
	});

	const allModelsReport = async (_args: string, ctx: ExtensionCommandContext) => {
		const now = new Date();
		const tz = displayTz;
		const model = ctx.model;
		const current =
			model && findProvider(rules, model.provider)
				? { providerId: model.provider, modelId: model.id }
				: null;
		const lines = reportLines(rules, current, now, tz);
		if (ctx.hasUI) {
			ctx.ui.notify(lines.join("\n"), "info");
		} else {
			console.log(lines.join("\n"));
		}
	};

	pi.registerCommand("peak", {
		description: "Peak/off-peak rating for all tracked models (config: ~/.pi/agent/peak-hours.json)",
		handler: allModelsReport,
	});

	pi.registerCommand("ph", {
		description: "Shorter alias for /peak — all tracked models with cost ratings",
		handler: allModelsReport,
	});
}

export type { PeakHoursConfig } from "./config.ts";
