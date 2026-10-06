import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MERGE_CUSTOM_TYPE } from "../src/constants.ts";
import {
	buildMergeMessage,
	buildTranscript,
	deliveredRequestIds,
	findPendingMerges,
	isMergeRequest,
	lastAssistantText,
	type MergeRequest,
} from "../src/merge.ts";

const message = (role: string, content: unknown, extra: Record<string, unknown> = {}) => ({
	type: "message",
	message: { role, content, ...extra },
});

test("transcript keeps user and assistant text and drops tool traffic and thinking", () => {
	const transcript = buildTranscript([
		message("user", "Why X?"),
		message("assistant", [
			{ type: "thinking", thinking: "secret" },
			{ type: "text", text: "Because Y." },
			{ type: "toolCall", name: "read", arguments: {} },
		]),
		message("toolResult", [{ type: "text", text: "file body" }]),
		{ type: "custom_message", content: "x" },
		message("assistant", [{ type: "text", text: "Done." }]),
	]);
	assert.equal(transcript, "User:\nWhy X?\n\nAssistant:\nBecause Y.\n\nAssistant:\nDone.");
});

test("transcript drops the oldest turns over budget", () => {
	const entries = [message("user", "a".repeat(100)), message("assistant", "b".repeat(100)), message("user", "c".repeat(30))];
	const transcript = buildTranscript(entries, 160) ?? "";
	assert.ok(transcript.startsWith("[Earlier side-chat turns omitted"));
	assert.ok(transcript.includes("c".repeat(30)));
	assert.ok(!transcript.includes("a".repeat(100)));
	assert.equal(buildTranscript([]), undefined);
});

test("a single oversized turn keeps its tail", () => {
	const transcript = buildTranscript([message("assistant", `${"x".repeat(500)}END`)], 200) ?? "";
	assert.ok(Buffer.byteLength(transcript) <= 200);
	assert.ok(transcript.endsWith("END"));
});

test("last assistant text skips failed turns", () => {
	assert.equal(lastAssistantText([message("assistant", "ok"), message("user", "go")]), "ok");
	assert.equal(lastAssistantText([message("assistant", "partial", { stopReason: "aborted" })]), undefined);
});

const request = (overrides: Partial<MergeRequest> = {}): MergeRequest => ({
	version: 1,
	requestId: "11111111-2222-3333-4444-555555555555",
	chatId: "chat-1",
	parentSessionId: "main",
	createdAt: "2026-10-06T10:00:00.000Z",
	mode: "transcript",
	title: "Why X",
	content: "User:\nWhy X?",
	prompt: "Apply it",
	...overrides,
});

test("merge requests are validated", () => {
	assert.ok(isMergeRequest(request()));
	assert.ok(!isMergeRequest(request({ prompt: " " })));
	assert.ok(!isMergeRequest(request({ requestId: "../x" })));
	assert.ok(!isMergeRequest({ ...request(), version: 2 }));
});

test("merge message wraps the content", () => {
	const text = buildMergeMessage(request({ mode: "summary" }));
	assert.match(text, /^Merged from side chat "Why X" \(summary\)/);
	assert.match(text, /<side-chat>\nUser:\nWhy X\?\n<\/side-chat>$/);
});

test("delivered request IDs come from merge custom messages", () => {
	const ids = deliveredRequestIds([
		{ type: "custom_message", customType: MERGE_CUSTOM_TYPE, details: { requestId: "r1" } },
		{ type: "custom_message", customType: "other", details: { requestId: "r2" } },
	]);
	assert.deepEqual([...ids], ["r1"]);
});

test("pending merges are found per chat dir, oldest first; invalid files are removed", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-herdr-side-test-"));
	try {
		mkdirSync(join(dir, "chat-a"));
		mkdirSync(join(dir, "chat-b"));
		writeFileSync(join(dir, "chat-a", "merge-2.json"), JSON.stringify(request({ requestId: "r2", createdAt: "2026-10-06T11:00:00.000Z" })));
		writeFileSync(join(dir, "chat-b", "merge-1.json"), JSON.stringify(request({ requestId: "r1" })));
		writeFileSync(join(dir, "chat-b", "merge-bad.json"), JSON.stringify({ version: 1 }));
		writeFileSync(join(dir, "chat-b", "meta.json"), "{}");
		const pending = await findPendingMerges(dir, "main");
		assert.deepEqual(pending.map((merge) => merge.request.requestId), ["r1", "r2"]);
		assert.deepEqual(readdirSync(join(dir, "chat-b")).sort(), ["merge-1.json", "meta.json"]);
		assert.deepEqual(await findPendingMerges(join(dir, "missing"), "main"), []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
