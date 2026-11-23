import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import {
	createHerdrHost,
	type ExecResult,
	Herdr,
	HerdrApp,
	HerdrError,
	herdrEnvironmentProblem,
	isShellReady,
	parseHerdrFailure,
} from "../src/herdr.ts";

test("shell readiness needs the shell to be the only foreground process", () => {
	const info = (pids: number[]) => ({ process_info: { shell_pid: 10, foreground_processes: pids.map((pid) => ({ pid })) } });
	assert.ok(isShellReady(info([10])));
	assert.ok(!isShellReady(info([11, 10])));
	assert.ok(!isShellReady(info([])));
	assert.ok(!isShellReady({}));
});

test("herdr failures expose the server error code", () => {
	const error = parseHerdrFailure({
		code: 1,
		killed: false,
		stdout: "",
		stderr: '{"error":{"code":"pane_not_found","message":"pane w1:p9 not found"},"id":"x"}',
	});
	assert.equal(error.code, "pane_not_found");
	assert.equal(error.message, "pane w1:p9 not found");
	assert.equal(parseHerdrFailure({ code: 2, killed: false, stdout: "", stderr: "usage" }).message, "usage");
	assert.equal(parseHerdrFailure({ code: 3, killed: false, stdout: "", stderr: "" }).message, "herdr exited with code 3");
});

const ok = (result: unknown): ExecResult => ({ code: 0, killed: false, stderr: "", stdout: JSON.stringify({ id: "x", result }) });
const failure = (code: string, message: string): ExecResult => ({
	code: 1,
	killed: false,
	stdout: "",
	stderr: JSON.stringify({ id: "x", error: { code, message } }),
});

/** A Herdr client whose exec answers from a function and records the calls. */
function fakeHerdr(answer: (args: string[]) => ExecResult) {
	const calls: Array<{ command: string; args: string[] }> = [];
	const herdr = new Herdr(
		async (command, args) => {
			calls.push({ command, args });
			return answer(args);
		},
		{ HERDR_BIN_PATH: "/bin/herdr-test" },
	);
	return { herdr, calls };
}

test("exists maps pane_not_found to false and rethrows other failures", async () => {
	const exists = fakeHerdr(() => ok({ pane: { pane_id: "w1:p2" } }));
	assert.equal(await exists.herdr.exists("w1:p2"), true);
	assert.deepEqual(exists.calls, [{ command: "/bin/herdr-test", args: ["pane", "get", "w1:p2"] }]);

	const missing = fakeHerdr(() => failure("pane_not_found", "pane w1:p2 not found"));
	assert.equal(await missing.herdr.exists("w1:p2"), false);

	const broken = fakeHerdr(() => failure("internal", "boom"));
	await assert.rejects(broken.herdr.exists("w1:p2"), (error: unknown) => error instanceof HerdrError && error.code === "internal");
});

test("pane results are validated", async () => {
	assert.equal(await fakeHerdr(() => ok({ pane: { pane_id: "w1:p1" } })).herdr.currentId(), "w1:p1");
	await assert.rejects(fakeHerdr(() => ok({ pane: { pane_id: "-x" } })).herdr.currentId(), /no valid pane_id/);
	await assert.rejects(fakeHerdr(() => ({ code: 0, killed: false, stdout: "nope", stderr: "" })).herdr.currentId(), /invalid JSON/);
	await assert.rejects(fakeHerdr(() => ({ code: 0, killed: false, stdout: "", stderr: "" })).herdr.currentId(), HerdrError);
	await assert.rejects(fakeHerdr(() => ({ code: 0, killed: true, stdout: "", stderr: "" })).herdr.currentId(), /timed out/);

	const layout = fakeHerdr(() => ok({ layout: { panes: [{ pane_id: "w1:p1", rect: { width: 200, height: 50 } }] } }));
	assert.deepEqual(await layout.herdr.paneRect("w1:p1"), { width: 200, height: 50 });
	await assert.rejects(layout.herdr.paneRect("w1:p9"), /no valid size/);
});

test("split passes direction, cwd, and focus", async () => {
	const { herdr, calls } = fakeHerdr(() => ok({ pane: { pane_id: "w1:p3" } }));
	assert.equal(await herdr.split("w1:p1", "right", "/work"), "w1:p3");
	assert.deepEqual(calls[0]?.args, ["pane", "split", "--pane", "w1:p1", "--direction", "right", "--cwd", "/work", "--focus"]);
});

test("waitForShell stops on pane_not_found", async () => {
	const { herdr } = fakeHerdr(() => failure("pane_not_found", "gone"));
	await assert.rejects(herdr.waitForShell("w1:p3", 1_000, 1), (error: unknown) => error instanceof HerdrError && error.code === "pane_not_found");
	const ready = fakeHerdr(() => ok({ process_info: { shell_pid: 5, foreground_processes: [{ pid: 5 }] } }));
	assert.equal(await ready.herdr.waitForShell("w1:p3", 1_000, 1), true);
});

test("the TUI wins over the app when both environments are present", () => {
	const exec = async (): Promise<ExecResult> => ({ code: 0, killed: false, stdout: "", stderr: "" });
	const tui = { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: "/s" };
	assert.ok(createHerdrHost(exec, { ...tui, HC_TERMINAL_ID: "t3" }) instanceof Herdr);
	assert.ok(createHerdrHost(exec, { HC_TERMINAL_ID: "t3" }) instanceof HerdrApp);
	assert.equal(herdrEnvironmentProblem(tui), undefined);
	assert.equal(herdrEnvironmentProblem({ HC_TERMINAL_ID: "t3" }), undefined);
	assert.match(herdrEnvironmentProblem({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" }) ?? "", /HERDR_SOCKET_PATH/);
	assert.match(herdrEnvironmentProblem({}) ?? "", /Herdr app terminal/);
});

/** A Herdr app client whose exec answers from a function and records the calls. */
function fakeApp(answer: (command: string, args: string[]) => unknown, code = 0) {
	const calls: Array<{ command: string; args: string[] }> = [];
	const app = new HerdrApp(
		async (command, args) => {
			calls.push({ command, args });
			return { code, killed: false, stdout: JSON.stringify(answer(command, args)), stderr: "" };
		},
		{ HC_TERMINAL_ID: "t3" },
	);
	return { app, calls };
}

const listing = { spaces: [{ tabs: [{ terminals: [{ terminal: "t9", pane: "p9" }, { terminal: "t3", pane: "p3" }] }] }] };

test("app openBeside splits the main terminal's pane and runs the script in cwd", async () => {
	const { app, calls } = fakeApp((command, args) => {
		if (command === "hc") return { cols: 62, rows: 38, state: "live" };
		if (args[0] === "ls") return listing;
		return { pane: "p4", terminal: "t4" };
	});
	assert.equal(await app.currentId(), "t3");
	assert.equal(await app.openBeside("t3", "/work dir", "/chat/launch.sh"), "t4");
	assert.deepEqual(calls.map((call) => [call.command, ...call.args.slice(0, 2)]), [
		["hc", "get", "t3"],
		["herdr-app", "ls"],
		["herdr-app", "do", "pane.split"],
	]);
	const split = JSON.parse(calls[2]?.args[2] ?? "{}") as { direction: string; pane: string; argv: string[] };
	assert.equal(split.direction, "down");
	assert.equal(split.pane, "p3");
	const run = spawnSync(split.argv[0] ?? "", [...split.argv.slice(1, 3), "sh", tmpdir(), "/no/such/launch.sh"], { encoding: "utf8" });
	assert.notEqual(run.status, 0, "a missing script fails after cd");
});

test("app openBeside fails when the window does not show the main terminal", async () => {
	const { app } = fakeApp((command) => (command === "hc" ? { cols: 200, rows: 50 } : { spaces: [] }));
	await assert.rejects(app.openBeside("t3", "/w", "/l"), /no pane for terminal t3/);
});

test("app exists maps hc not_found to false and finished terminals to false", async () => {
	assert.equal(await fakeApp(() => ({ state: "live" })).app.exists("t4"), true);
	assert.equal(await fakeApp(() => ({ state: "finished" })).app.exists("t4"), false);
	assert.equal(await fakeApp(() => ({ error: { kind: "not_found", message: "no terminal" } }), 3).app.exists("t4"), false);
	await assert.rejects(fakeApp(() => ({ error: { kind: "io", message: "boom" } }), 1).app.exists("t4"), /boom/);
});

test("app focus targets the terminal and surfaces herdr-app errors", async () => {
	const ok = fakeApp(() => ({ ok: true }));
	await ok.app.focus("t4");
	assert.deepEqual(ok.calls[0]?.args, ["do", "pane.focus", '{"terminal":"t4"}']);
	await assert.rejects(fakeApp(() => ({ error: 'no terminal "t4"' }), 1).app.focus("t4"), /no terminal "t4"/);
});
