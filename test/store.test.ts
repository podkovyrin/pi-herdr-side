import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { summaryPrompt } from "../src/constants.ts";
import { buildForkSession } from "../src/fork.ts";
import {
	type ChatMeta,
	detectSideChatDir,
	ensurePrivateDir,
	entriesAfterNote,
	entriesSinceLastMerge,
	isChatMeta,
	isInsideDir,
	isSafePathPart,
	isToolName,
	listChats,
	parentDir,
	readChatEntries,
	readLiveMarker,
	removeOwnLiveMarker,
	sideChatDirOf,
	sideChatName,
	summarizeChatEntries,
	withoutSummaryTurns,
	writeJson,
	writeLiveMarker,
} from "../src/store.ts";

test("unsafe path parts are rejected", () => {
	assert.ok(isSafePathPart("01a110aa-83c2-7073-9a5a-c539f33371ce"));
	for (const bad of ["", "..", "a/b", ".hidden", "a..b", "-x"]) assert.ok(!isSafePathPart(bad), bad);
	assert.throws(() => parentDir("/r", "../x"));
});

const user = (id: string, content: unknown) => ({ type: "message", id, message: { role: "user", content } });
const assistant = (id: string, content: unknown) => ({ type: "message", id, message: { role: "assistant", content } });

test("chat title and question count ignore the forked main history", () => {
	const entries = [
		user("m1", "main question"),
		{ type: "custom_message", id: "note" },
		user("s1", [{ type: "text", text: "side\nquestion" }]),
		assistant("s2", "answer"),
		user("s3", "follow-up"),
	];
	assert.deepEqual(summarizeChatEntries(entries, "note"), { title: "side question", questions: 2, messages: 3 });
	assert.deepEqual(summarizeChatEntries([...entries, { type: "session_info", name: "Named" }], "note").title, "Named");
	assert.deepEqual(summarizeChatEntries(entries.slice(0, 2), "note"), { title: "Untitled side chat", questions: 0, messages: 0 });
	assert.deepEqual(entriesAfterNote(entries, "note").map((entry) => entry.id), ["s1", "s2", "s3"]);
	assert.deepEqual(entriesAfterNote(entries, "nope"), []);
});

test("the main session's name, copied by the fork, is not the side chat's name", () => {
	const entries = [
		{ type: "session_info", id: "i0", name: "Main session name" },
		user("m1", "main question"),
		{ type: "custom_message", id: "note" },
	];
	assert.equal(sideChatName(entries, "note"), undefined);
	assert.equal(summarizeChatEntries(entries, "note").title, "Untitled side chat");
	const asked = [...entries, user("s1", "side question")];
	assert.equal(summarizeChatEntries(asked, "note").title, "side question");
	const named = [...asked, { type: "session_info", id: "i1", name: " Side name " }];
	assert.equal(sideChatName(named, "note"), "Side name");
	// An empty name clears the name, as in pi.
	const cleared = [...named, { type: "session_info", id: "i2", name: "" }];
	assert.equal(sideChatName(cleared, "note"), undefined);
	assert.equal(summarizeChatEntries(cleared, "note").title, "side question");
});

test("summary turns do not count as side-chat turns", () => {
	const entries = [
		{ type: "custom_message", id: "note" },
		user("s1", "real question"),
		assistant("s2", "real answer"),
		user("s3", summaryPrompt(false)),
		assistant("s4", "the summary"),
		{ type: "custom", id: "mark", customType: "pi-herdr-side.merged" },
		user("s5", [{ type: "text", text: summaryPrompt(true) }]),
		{ type: "message", id: "s6", message: { role: "toolResult", content: "x" } },
		assistant("s7", "second summary"),
		user("s8", "after"),
	];
	assert.deepEqual(withoutSummaryTurns(entries).map((entry) => entry.id), ["note", "s1", "s2", "mark", "s8"]);
	assert.deepEqual(summarizeChatEntries(entries, "note"), { title: "real question", questions: 2, messages: 3 });
	const onlySummary = [{ type: "custom_message", id: "note" }, user("s1", summaryPrompt(false)), assistant("s2", "x")];
	assert.deepEqual(summarizeChatEntries(onlySummary, "note"), { title: "Untitled side chat", questions: 0, messages: 0 });
});

test("live markers count only while their process is alive", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-herdr-side-test-"));
	try {
		const path = join(dir, "pane.json");
		await writeLiveMarker(path, "w1:p2");
		assert.deepEqual(await readLiveMarker(path), { pid: process.pid, paneId: "w1:p2" });
		assert.equal(statSync(path).mode & 0o777, 0o600);
		await writeJson(path, { pid: 999_999_999, paneId: "w1:p2" });
		assert.equal(await readLiveMarker(path), undefined);
		await removeOwnLiveMarker(path);
		assert.ok(statSync(path), "a marker owned by another pid is kept");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

const mainBranch = [
	{ type: "session_info", id: "a0", parentId: null, name: "Main name" },
	{ type: "message", id: "a1", parentId: "a0", message: { role: "user", content: "main ✓ question" } },
];

async function writeChat(
	dir: string,
	chatId: string,
	options: { name?: string; ageMs?: number; extraLines?: unknown[]; offset?: boolean } = {},
) {
	const chatDir = join(dir, chatId);
	await ensurePrivateDir(chatDir);
	const now = new Date(Date.now() - (options.ageMs ?? 0));
	const fork = buildForkSession({
		sessionId: "main",
		sessionVersion: 3,
		cwd: "/",
		branch: mainBranch,
		note: "N",
		...(options.name ? { name: options.name } : {}),
		now,
	});
	const extra = (options.extraLines ?? []).map((line) => `${JSON.stringify(line)}\n`).join("");
	const sessionFile = join(chatDir, fork.fileName);
	writeFileSync(sessionFile, fork.content + extra);
	const meta: ChatMeta = {
		version: 1, chatId, parentSessionId: "main", parentSessionFile: null, cwd: "/",
		createdAt: now.toISOString(), sessionFileName: fork.fileName, noteEntryId: fork.noteEntryId,
		...(options.offset === false ? {} : { noteByteOffset: fork.noteByteOffset }),
	};
	await writeJson(join(chatDir, "meta.json"), meta);
	utimesSync(sessionFile, now, now);
	return { chatDir, sessionFile, meta, fork };
}

const turn = (text: string) => [user("t1", text), assistant("t2", "answer")];

test("chats are listed newest first with titles", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-herdr-side-test-"));
	try {
		await writeChat(dir, "c1", { name: "older", ageMs: 60_000, extraLines: turn("q") });
		await writeChat(dir, "c2", { name: "newer", extraLines: turn("q") });
		await ensurePrivateDir(join(dir, "broken"));
		const chats = await listChats(dir);
		assert.deepEqual(chats.map((chat) => chat.title), ["newer", "older"]);
		assert.equal(statSync(join(dir, "c1")).mode & 0o777, 0o700);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("chat entries are read from the note offset, with a full parse as fallback", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-herdr-side-test-"));
	try {
		const { sessionFile, meta, fork } = await writeChat(dir, "c1", { extraLines: turn("side question") });
		const fast = await readChatEntries(sessionFile, meta);
		assert.equal(fast.entries[0]?.id, fork.noteEntryId, "starts at the note");
		assert.equal(fast.entries.length, 3);
		// A stale offset, for example after pi rewrote the file, falls back to the whole file.
		const stale = await readChatEntries(sessionFile, { ...meta, noteByteOffset: 5 });
		assert.equal(stale.entries[0]?.type, "session");
		assert.equal(summarizeChatEntries(stale.entries, meta.noteEntryId).title, "side question");
		const beyond = await readChatEntries(sessionFile, { ...meta, noteByteOffset: 10_000_000 });
		assert.equal(beyond.entries[0]?.type, "session");
		const { noteByteOffset: _, ...legacy } = meta;
		assert.ok(isChatMeta(legacy), "metas without the offset stay valid");
		assert.ok(!isChatMeta({ ...meta, noteByteOffset: -1 }));
		assert.ok(isChatMeta({ ...meta, tools: ["read", "codemode"] }));
		assert.ok(isChatMeta({ ...meta, tools: [] }));
		assert.ok(!isChatMeta({ ...meta, tools: "read" }));
		assert.ok(!isChatMeta({ ...meta, tools: ["read,bash"] }));
		assert.ok(!isChatMeta({ ...meta, tools: [""] }));
		const stored = ["read", "bad name", "a,b", "", "codemode"].filter(isToolName);
		assert.deepEqual(stored, ["read", "codemode"]);
		assert.ok(isChatMeta({ ...meta, tools: stored }), "filtered names keep the meta valid");
		assert.equal((await readChatEntries(sessionFile, legacy)).entries[0]?.type, "session");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("listing for the menu deletes old chats that never ran a turn", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-herdr-side-test-"));
	try {
		const old = await writeChat(dir, "old-empty", { name: "never ran", ageMs: 120_000 });
		await writeChat(dir, "new-empty", { ageMs: 1_000 });
		const open = await writeChat(dir, "open-empty", { ageMs: 120_000 });
		await writeLiveMarker(join(open.chatDir, "pane.json"), "w1:p3");
		await writeChat(dir, "used", { ageMs: 120_000, extraLines: turn("q") });
		const listed = await listChats(dir);
		assert.equal(listed.length, 4, "no pruning without the option");
		const chats = await listChats(dir, { pruneEmptyAfterMs: 60_000 });
		assert.deepEqual(chats.map((chat) => chat.meta.chatId).sort(), ["new-empty", "open-empty", "used"]);
		assert.ok(!existsSync(old.chatDir));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("side-chat session files are recognized by path", () => {
	const root = "/home/u/.pi/agent/side-sessions";
	assert.equal(sideChatDirOf(`${root}/main-id/chat-1/2026_main-id.jsonl`, root), `${root}/main-id/chat-1`);
	assert.equal(sideChatDirOf(`${root}/main-id/chat-1/../chat-2/f.jsonl`, root), `${root}/main-id/chat-2`);
	assert.equal(sideChatDirOf(`${root}/main-id/f.jsonl`, root), undefined);
	assert.equal(sideChatDirOf(`${root}/main-id/chat-1/sub/f.jsonl`, root), undefined);
	assert.equal(sideChatDirOf("/home/u/.pi/agent/sessions/x/f.jsonl", root), undefined);
	assert.equal(sideChatDirOf(`${root}/../side-sessions2/a/b/f.jsonl`, root), undefined);
	assert.equal(sideChatDirOf(`${root}/main-id/.hidden/f.jsonl`, root), undefined);
	assert.ok(isInsideDir(`${root}/x/y/z.jsonl`, root));
	assert.ok(!isInsideDir(root, root));
	assert.ok(!isInsideDir(`${root}2/x`, root));
});

test("side-chat detection needs a valid meta.json for the chat", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-herdr-side-test-"));
	try {
		const { chatDir, sessionFile } = await writeChat(join(root, "main"), "chat-1", {});
		assert.equal(await detectSideChatDir(sessionFile, root), chatDir);
		assert.equal(await detectSideChatDir(undefined, root), undefined);
		const { sessionFile: orphan } = await writeChat(join(root, "main"), "chat-2", {});
		rmSync(join(root, "main", "chat-2", "meta.json"));
		assert.equal(await detectSideChatDir(orphan, root), undefined);
		// meta.json of another chat does not count.
		const { sessionFile: moved, meta } = await writeChat(join(root, "main"), "chat-3", {});
		await writeJson(join(root, "main", "chat-3", "meta.json"), { ...meta, chatId: "other" });
		assert.equal(await detectSideChatDir(moved, root), undefined);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("entries since the last merge marker", () => {
	const entries = [
		{ type: "message", id: "a", parentId: null },
		{ type: "custom", id: "m1", parentId: "a", customType: "pi-herdr-side.merged" },
		{ type: "message", id: "b", parentId: "m1" },
	];
	assert.deepEqual(entriesSinceLastMerge(entries), { entries: [entries[2]], mergedBefore: true });
	assert.deepEqual(entriesSinceLastMerge(entries.slice(0, 1)), { entries: entries.slice(0, 1), mergedBefore: false });
});
