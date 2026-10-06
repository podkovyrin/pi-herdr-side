import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	buildLaunchScript,
	buildPiArgs,
	chooseDirection,
	currentPiCommand,
	forwardedEnv,
	protectInitialMessage,
	shellQuote,
	sideChatTools,
} from "../src/launch.ts";

test("split direction compares width with twice the height", () => {
	assert.equal(chooseDirection({ width: 270, height: 74 }), "right");
	assert.equal(chooseDirection({ width: 120, height: 74 }), "down");
	assert.equal(chooseDirection({ width: 148, height: 74 }), "right");
});

test("new chat args pin model, thinking, and the tool list", () => {
	assert.deepEqual(
		buildPiArgs({
			kind: "new",
			sessionFile: "/d/s.jsonl",
			chatDir: "/d",
			provider: "openrouter",
			modelId: "anthropic/claude-opus-5.5",
			thinkingLevel: "high",
			tools: ["read", "bash"],
			question: "-x why?",
		}),
		[
			"--session", "/d/s.jsonl", "--session-dir", "/d", "--side-chat", "/d",
			"--provider", "openrouter", "--model", "anthropic/claude-opus-5.5", "--thinking", "high",
			"--tools", "read,bash", "--", "-x why?",
		],
	);
});

test("no active tools means --no-tools, and resume passes no overrides", () => {
	const args = buildPiArgs({ kind: "new", sessionFile: "f", chatDir: "d", provider: "p", modelId: "m", thinkingLevel: "off", tools: [] });
	assert.ok(args.includes("--no-tools"));
	assert.ok(!args.includes("--"));
	assert.deepEqual(buildPiArgs({ kind: "resume", sessionFile: "f", chatDir: "d" }), ["--session", "f", "--session-dir", "d", "--side-chat", "d"]);
});

test("resume passes the stored tool list when the chat has one", () => {
	const base = ["--session", "f", "--session-dir", "d", "--side-chat", "d"];
	assert.deepEqual(buildPiArgs({ kind: "resume", sessionFile: "f", chatDir: "d", tools: ["read", "codemode"] }), [...base, "--tools", "read,codemode"]);
	assert.deepEqual(buildPiArgs({ kind: "resume", sessionFile: "f", chatDir: "d", tools: [] }), [...base, "--no-tools"]);
});

test("MCP tools stay out of --tools, so pi does not filter MCP tools by the list", () => {
	assert.deepEqual(sideChatTools(["read", "mcp__radius__query", "codemode", "list_mcp_resources"]), ["read", "codemode", "list_mcp_resources"]);
	// Without any other tool, the MCP names are the only way to keep the set.
	assert.deepEqual(sideChatTools(["mcp__radius__query"]), ["mcp__radius__query"]);
	assert.deepEqual(sideChatTools([]), []);
	const args = buildPiArgs({
		kind: "new", sessionFile: "f", chatDir: "d", provider: "p", modelId: "m", thinkingLevel: "off",
		tools: ["read", "mcp__a__b", "codemode"],
	});
	assert.equal(args[args.indexOf("--tools") + 1], "read,codemode");
});

test("the side chat runs the same pi as the main process", () => {
	assert.deepEqual(currentPiCommand("/opt/node", "/pi/cli.js", () => true), ["/opt/node", "/pi/cli.js"]);
	assert.deepEqual(currentPiCommand("/opt/node", "/pi/cli.js", () => false), ["pi"]);
	assert.deepEqual(currentPiCommand("/opt/node", "", () => true), ["pi"]);
	assert.deepEqual(currentPiCommand("/opt/node", "relative.js", () => true), ["pi"]);
	// The test runner itself: node and an existing script.
	assert.deepEqual(currentPiCommand(), [process.execPath, process.argv[1]]);
});

test("PI_* and proxy variables are forwarded, per-call bash variables are not", () => {
	const env = forwardedEnv({
		PI_CODING_AGENT_DIR: "/a",
		PI_MANAGED_INSTALL_ROOT: "/b",
		PI_SESSION_ID: "x",
		PI_SESSION_FILE: "x",
		PI_PROVIDER: "x",
		PI_MODEL: "x",
		PI_REASONING_LEVEL: "x",
		HTTPS_PROXY: "http://p",
		no_proxy: "localhost",
		OPENAI_API_KEY: "secret",
		HOME: "/home",
		"PI_BAD-NAME": "x",
	});
	assert.deepEqual(env, { PI_CODING_AGENT_DIR: "/a", PI_MANAGED_INSTALL_ROOT: "/b", HTTPS_PROXY: "http://p", no_proxy: "localhost" });
});

test("a leading @ is not read as a file reference", () => {
	assert.equal(protectInitialMessage("@foo.ts?"), " @foo.ts?");
	assert.equal(protectInitialMessage("what about @foo"), "what about @foo");
});

test("launch script passes arguments and exported variables through sh unchanged", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-herdr-side-test-"));
	try {
		const fakePi = join(dir, "fake-pi");
		writeFileSync(fakePi, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done\nprintf '%s\\n' "$PI_TEST_VALUE" "$https_proxy"\n`, { mode: 0o755 });
		const tricky = ["it's", 'a "q"', "$HOME `x`", "multi\nline", "--"];
		const value = "it's $HOME\n`x`";
		const script = join(dir, "launch.sh");
		writeFileSync(script, buildLaunchScript(tricky, [fakePi], { PI_TEST_VALUE: value, https_proxy: "http://p:1", "bad name": "x" }));
		const output = execFileSync("sh", [script], { encoding: "utf8", env: { PATH: process.env.PATH } });
		assert.equal(output, `${[...tricky, value, "http://p:1"].join("\n")}\n`);
		assert.equal(shellQuote("a'b"), `'a'\\''b'`);

		// An interpreter and a script, as when pi runs as `node cli.js`.
		const fakeCli = join(dir, "cli.sh");
		writeFileSync(fakeCli, `printf 'cli %s\\n' "$@"\n`);
		writeFileSync(script, buildLaunchScript(["x"], ["/bin/sh", fakeCli]));
		assert.equal(execFileSync("sh", [script], { encoding: "utf8" }), "cli x\n");

		// The runtime's directory goes on PATH once, as the managed pi shim does.
		const binDir = join(dir, "node bin");
		mkdirSync(binDir);
		const runtime = join(binDir, "node");
		writeFileSync(runtime, `#!/bin/sh\nprintf '%s\\n' "$PATH"\n`, { mode: 0o755 });
		writeFileSync(script, buildLaunchScript([], [runtime, fakeCli]));
		assert.equal(execFileSync("sh", [script], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } }), `${binDir}:/usr/bin:/bin\n`);
		assert.equal(execFileSync("sh", [script], { encoding: "utf8", env: { PATH: `/usr/bin:${binDir}:/bin` } }), `/usr/bin:${binDir}:/bin\n`);
		assert.ok(!buildLaunchScript([], ["pi"]).includes("PATH"), "a plain pi from PATH needs no change");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("launch script reports a missing pi and waits for Enter", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-herdr-side-test-"));
	try {
		const script = join(dir, "launch.sh");
		for (const command of [[join(dir, "missing-pi")], ["/bin/sh", join(dir, "missing-cli.js")], ["pi-herdr-side-no-such-command"]]) {
			writeFileSync(script, buildLaunchScript(["--session", "f"], command));
			const result = spawnSync("sh", [script], { encoding: "utf8", input: "\n" });
			assert.equal(result.status, 127);
			assert.match(result.stderr, /cannot start pi/);
			assert.match(result.stderr, /Press Enter/);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
