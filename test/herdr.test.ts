import assert from "node:assert/strict";
import { test } from "node:test";
import { type ExecResult, Herdr, HerdrError, isShellReady, parseHerdrFailure } from "../src/herdr.ts";

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

test("paneExists maps pane_not_found to false and rethrows other failures", async () => {
	const exists = fakeHerdr(() => ok({ pane: { pane_id: "w1:p2" } }));
	assert.equal(await exists.herdr.paneExists("w1:p2"), true);
	assert.deepEqual(exists.calls, [{ command: "/bin/herdr-test", args: ["pane", "get", "w1:p2"] }]);

	const missing = fakeHerdr(() => failure("pane_not_found", "pane w1:p2 not found"));
	assert.equal(await missing.herdr.paneExists("w1:p2"), false);

	const broken = fakeHerdr(() => failure("internal", "boom"));
	await assert.rejects(broken.herdr.paneExists("w1:p2"), (error: unknown) => error instanceof HerdrError && error.code === "internal");
});

test("pane results are validated", async () => {
	assert.equal(await fakeHerdr(() => ok({ pane: { pane_id: "w1:p1" } })).herdr.currentPaneId(), "w1:p1");
	await assert.rejects(fakeHerdr(() => ok({ pane: { pane_id: "-x" } })).herdr.currentPaneId(), /no valid pane_id/);
	await assert.rejects(fakeHerdr(() => ({ code: 0, killed: false, stdout: "nope", stderr: "" })).herdr.currentPaneId(), /invalid JSON/);
	await assert.rejects(fakeHerdr(() => ({ code: 0, killed: false, stdout: "", stderr: "" })).herdr.currentPaneId(), HerdrError);
	await assert.rejects(fakeHerdr(() => ({ code: 0, killed: true, stdout: "", stderr: "" })).herdr.currentPaneId(), /timed out/);

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
