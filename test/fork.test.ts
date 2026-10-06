import assert from "node:assert/strict";
import { test } from "node:test";
import { NOTE_CUSTOM_TYPE } from "../src/constants.ts";
import { buildForkSession, sessionFileName } from "../src/fork.ts";

const branch = [
	{ type: "model_change", id: "a1", parentId: null, provider: "p", modelId: "m" },
	{ type: "message", id: "a2", parentId: "a1", message: { role: "system", content: "", sections: { cwd: "/x" } } },
	{ type: "message", id: "a3", parentId: "a2", message: { role: "user", content: "hi" } },
];
const now = new Date("2026-10-06T10:02:52.738Z");

test("session file name follows pi's convention", () => {
	assert.equal(sessionFileName("abc-1", now), "2026-10-06T10-02-52-738Z_abc-1.jsonl");
});

test("fork reuses the main session ID and copies the branch unchanged", () => {
	const fork = buildForkSession({
		sessionId: "main-id",
		sessionVersion: 3,
		cwd: "/x",
		parentSessionFile: "/s/main.jsonl",
		branch,
		note: "NOTE",
		now,
	});
	const lines = fork.content.trimEnd().split("\n").map((line) => JSON.parse(line));
	assert.deepEqual(lines[0], {
		type: "session",
		version: 3,
		id: "main-id",
		timestamp: now.toISOString(),
		cwd: "/x",
		parentSession: "/s/main.jsonl",
	});
	assert.deepEqual(lines.slice(1, 4), branch);
	const note = lines[4];
	assert.equal(note.type, "custom_message");
	assert.equal(note.customType, NOTE_CUSTOM_TYPE);
	assert.equal(note.parentId, "a3");
	assert.equal(note.display, false);
	assert.equal(note.id, fork.noteEntryId);
	assert.equal(lines.length, 5);
});

test("fork appends a session name after the note", () => {
	const fork = buildForkSession({ sessionId: "s", sessionVersion: 3, cwd: "/", branch, note: "N", name: "Why?", now });
	const lines = fork.content.trimEnd().split("\n").map((line) => JSON.parse(line));
	const info = lines.at(-1);
	assert.equal(info.type, "session_info");
	assert.equal(info.name, "Why?");
	assert.equal(info.parentId, fork.noteEntryId);
	assert.equal("parentSession" in lines[0], false);
});

test("fork of an empty session starts at the note", () => {
	const fork = buildForkSession({ sessionId: "s", sessionVersion: 3, cwd: "/", branch: [], note: "N", now });
	const lines = fork.content.trimEnd().split("\n").map((line) => JSON.parse(line));
	assert.equal(lines.length, 2);
	assert.equal(lines[1].parentId, null);
});
