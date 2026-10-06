import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildLaunchScript, buildPiArgs, chooseDirection, protectInitialMessage, shellQuote } from "../src/launch.ts";

test("split direction compares width with twice the height", () => {
	assert.equal(chooseDirection({ width: 270, height: 74 }), "right");
	assert.equal(chooseDirection({ width: 120, height: 74 }), "down");
	assert.equal(chooseDirection({ width: 148, height: 74 }), "right");
});

test("new chat args pin model, thinking, and the exact tool list", () => {
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

test("a leading @ is not read as a file reference", () => {
	assert.equal(protectInitialMessage("@foo.ts?"), " @foo.ts?");
	assert.equal(protectInitialMessage("what about @foo"), "what about @foo");
});

test("launch script passes arguments through sh unchanged", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-herdr-side-test-"));
	try {
		const fakePi = join(dir, "fake-pi");
		writeFileSync(fakePi, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done\n`, { mode: 0o755 });
		const tricky = ["it's", 'a "q"', "$HOME `x`", "multi\nline", "--"];
		const script = join(dir, "launch.sh");
		writeFileSync(script, buildLaunchScript(tricky, fakePi));
		const output = execFileSync("sh", [script], { encoding: "utf8" });
		assert.equal(output, `${tricky.join("\n")}\n`);
		assert.equal(shellQuote("a'b"), `'a'\\''b'`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
