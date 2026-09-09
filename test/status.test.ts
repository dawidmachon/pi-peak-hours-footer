/**
 * Smoke test for the SETSTATUS (append-only) placement — the default and only
 * placement: pi concatenates keyed extension statuses, so this coexists with
 * any other extension's status line with zero conflict.
 * A temp config (show: always) is loaded BEFORE importing the extension entry.
 * Runs without a pi runtime:
 *   node test/status.test.ts
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "peak-hours-status-"));
const cfgFile = join(dir, "peak-hours.json");
writeFileSync(cfgFile, JSON.stringify({ show: "always" }));
process.env.PEAK_HOURS_CONFIG = cfgFile;

const { default: peakHoursFooter } = await import("../src/index.ts");

type Handler = (event: unknown, ctx: unknown) => void | Promise<void>;
const handlers: Record<string, Handler> = {};
const statusCalls: Array<{ key: string; text: string | undefined }> = [];
let footerSet = false;

const pi = {
	on: (name: string, fn: Handler) => {
		handlers[name] = fn;
	},
	registerCommand: () => {},
} as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI;

peakHoursFooter(pi);

// model carries BOTH id and display name (like pi's Model), and a separate
// statuses from other extensions may already be set (they coexist).
function fakeCtx(model: { provider: string; id: string; name: string } | undefined) {
	return {
		mode: "tui" as const,
		hasUI: true,
		model: model ? { provider: model.provider, id: model.id, name: model.name } : undefined,
		ui: {
			setStatus: (key: string, text: string | undefined) => statusCalls.push({ key, text }),
			setFooter: () => {
				footerSet = true;
			},
			notify: () => {},
		},
	};
}

let failures = 0;
const check = (name: string, cond: boolean, detail = ""): void => {
	if (cond) console.log(`  ok   ${name}`);
	else {
		failures += 1;
		console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
	}
};

await handlers.session_start?.(
	{ reason: "startup" },
	fakeCtx({ provider: "zai", id: "glm-5.3", name: "GLM-5.3" }),
);
check("setStatus placement: NO custom footer installed (append-only)", !footerSet);
const set = statusCalls.find((c) => c.key === "peak-hours" && c.text !== undefined);
check(
	"setStatus: peak-hours status set for GLM model (with decision symbol)",
	(set?.text ?? "").match(/[✓⚡✗🎁]/) !== null,
	JSON.stringify(statusCalls),
);

// model_select to a non-tracked provider → status cleared
await handlers.model_select?.({}, fakeCtx({ provider: "untracked-provider", id: "some-model", name: "Some Model" }));
check(
	"setStatus: clears peak-hours for non-tracked provider (others untouched)",
	statusCalls.some((c) => c.key === "peak-hours" && c.text === undefined) ?? false,
);

await handlers.session_shutdown?.({ reason: "quit" }, fakeCtx({ provider: "zai", id: "glm-5.3", name: "GLM-5.3" }));
check(
	"setStatus: shutdown clears status",
	statusCalls.some((c) => c.key === "peak-hours" && c.text === undefined) ?? false,
);

delete process.env.PEAK_HOURS_CONFIG;
rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? "\nstatus.test: all passed" : `\nstatus.test: ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);