/**
 * Dev-only smoke test: register handlers against a mock ExtensionAPI, fire
 * events, and assert the setStatus-based (append-only) wiring plus the
 * /peak and /ph commands.
 *
 * No pi runtime needed:
 *   node test/selfcheck.ts
 *
 * Uses a temp config (show:"always") so behavior is deterministic.
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "peak-hours-selfcheck-"));
writeFileSync(join(dir, "peak-hours.json"), JSON.stringify({ show: "always" }));
process.env.PEAK_HOURS_CONFIG = join(dir, "peak-hours.json");

const { default: peakHoursFooter } = await import("../src/index.ts");

type Handler = (event: unknown, ctx: unknown) => void | Promise<void>;
type CommandHandler = (args: string, ctx: unknown) => void | Promise<void>;

const handlers: Record<string, Handler> = {};
const commandHandlers: Record<string, CommandHandler> = {};
const statusCalls: Array<{ key: string; text: string | undefined }> = [];
const notified: string[] = [];

const pi = {
	on: (name: string, fn: Handler) => {
		handlers[name] = fn;
	},
	registerCommand: (name: string, def: { handler: CommandHandler }) => {
		commandHandlers[name] = def.handler;
	},
} as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI;

peakHoursFooter(pi);

let failures = 0;
const check = (name: string, cond: boolean, detail = ""): void => {
	if (cond) {
		console.log(`  ok   ${name}`);
	} else {
		failures += 1;
		console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
	}
};

let currentModel: { provider: string; id: string; name: string } | undefined;

const sharedCtx = {
	mode: "tui" as const,
	hasUI: true,
	get model() {
		return currentModel ? { provider: currentModel.provider, id: currentModel.id, name: currentModel.name } : undefined;
	},
	ui: {
		setStatus: (key: string, text: string | undefined) => statusCalls.push({ key, text }),
		notify: (msg: string) => notified.push(msg),
	},
};

check("session_start handler registered", typeof handlers.session_start === "function");
check("model_select handler registered", typeof handlers.model_select === "function");
check("session_shutdown handler registered", typeof handlers.session_shutdown === "function");
check("peak command registered", typeof commandHandlers.peak === "function");
check("ph alias registered", typeof commandHandlers.ph === "function");

// session_start with a GLM model → status set with decision symbol
currentModel = { provider: "zai", id: "glm-5.3", name: "GLM-5.3" };
await handlers.session_start?.({ reason: "startup" }, sharedCtx);
const setCall = statusCalls.find((c) => c.key === "peak-hours" && c.text !== undefined);
check(
	"session_start sets peak-hours status (✓/⚡/✗/🎁 symbol)",
	setCall !== undefined && /[✓⚡✗🎁]/.test(setCall.text ?? ""),
	JSON.stringify(statusCalls),
);

// model_select to an untracked provider → status cleared
currentModel = { provider: "untracked-provider", id: "some-model", name: "Some Model" };
await handlers.model_select?.({}, sharedCtx);
check(
	"model_select clears status for non-tracked provider",
	statusCalls.some((c) => c.key === "peak-hours" && c.text === undefined),
);

// switch back → set again
currentModel = { provider: "glm", id: "glm-5.3-flash", name: "GLM-5.3-Flash" };
await handlers.model_select?.({}, sharedCtx);
check(
	"model_select sets status again for GLM alias provider",
	statusCalls.some((c) => c.key === "peak-hours" && c.text !== undefined),
);

// /peak and /ph produce the all-models report
await commandHandlers.peak?.("", sharedCtx);
await commandHandlers.ph?.("", sharedCtx);
check("peak command produced a report", notified.length >= 2 && notified[0].includes("Peak/cost now"));
check("peak report lists model states + OK rating", notified[0].includes("OK") && notified[0].includes("—"));

// session_shutdown clears status
await handlers.session_shutdown?.({ reason: "quit" }, sharedCtx);
check(
	"session_shutdown clears status",
	statusCalls.some((c) => c.key === "peak-hours" && c.text === undefined),
);

delete process.env.PEAK_HOURS_CONFIG;
rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? "\nselfcheck: all passed" : `\nselfcheck: ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);