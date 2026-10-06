import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildForkSession } from "../src/fork.ts";
import { isShellReady, parseHerdrFailure } from "../src/herdr.ts";
import {
	type ChatMeta,
	ensurePrivateDir,
	entriesAfterNote,
	isSafePathPart,
	listChats,
	parentDir,
	readLiveMarker,
	removeOwnLiveMarker,
	summarizeChatEntries,
	writeJson,
	writeLiveMarker,
} from "../src/store.ts";

test("unsafe path parts are rejected", () => {
	assert.ok(isSafePathPart("01a110aa-83c2-7073-9a5a-c539f33371ce"));
	for (const bad of ["", "..", "a/b", ".hidden", "a..b", "-x"]) assert.ok(!isSafePathPart(bad), bad);
	assert.throws(() => parentDir("/r", "../x"));
});

test("chat title and question count ignore the forked main history", () => {
	const entries = [
		{ type: "message", id: "m1", message: { role: "user", content: "main question" } },
		{ type: "custom_message", id: "note" },
		{ type: "message", id: "s1", message: { role: "user", content: [{ type: "text", text: "side\nquestion" }] } },
		{ type: "message", id: "s2", message: { role: "assistant", content: "answer" } },
		{ type: "message", id: "s3", message: { role: "user", content: "follow-up" } },
	];
	assert.deepEqual(summarizeChatEntries(entries, "note"), { title: "side question", questions: 2 });
	assert.deepEqual(summarizeChatEntries([...entries, { type: "session_info", name: "Named" }], "note").title, "Named");
	assert.deepEqual(summarizeChatEntries(entries.slice(0, 2), "note"), { title: "Untitled side chat", questions: 0 });
	assert.deepEqual(entriesAfterNote(entries as never, "note").map((entry: { id: string }) => entry.id), ["s1", "s2", "s3"]);
	assert.deepEqual(entriesAfterNote(entries as never, "nope"), []);
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

test("chats are listed newest first with titles", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-herdr-side-test-"));
	try {
		for (const [chatId, name, age] of [["c1", "older", 60_000], ["c2", "newer", 0]] as const) {
			const chatDir = join(dir, chatId);
			await ensurePrivateDir(chatDir);
			const fork = buildForkSession({ sessionId: "main", sessionVersion: 3, cwd: "/", branch: [], note: "N", name, now: new Date() });
			writeFileSync(join(chatDir, fork.fileName), fork.content);
			const meta: ChatMeta = {
				version: 1, chatId, parentSessionId: "main", parentSessionFile: null, cwd: "/",
				createdAt: new Date().toISOString(), sessionFileName: fork.fileName, noteEntryId: fork.noteEntryId,
			};
			await writeJson(join(chatDir, "meta.json"), meta);
			const { utimesSync } = await import("node:fs");
			const time = new Date(Date.now() - age);
			utimesSync(join(chatDir, fork.fileName), time, time);
		}
		await ensurePrivateDir(join(dir, "broken"));
		const chats = await listChats(dir);
		assert.deepEqual(chats.map((chat) => chat.title), ["newer", "older"]);
		assert.equal(statSync(join(dir, "c1")).mode & 0o777, 0o700);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

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
});

test("entries since the last merge marker", async () => {
	const { entriesSinceLastMerge } = await import("../src/store.ts");
	const entries = [
		{ type: "message", id: "a", parentId: null },
		{ type: "custom", id: "m1", parentId: "a", customType: "pi-herdr-side.merged" },
		{ type: "message", id: "b", parentId: "m1" },
	];
	assert.deepEqual(entriesSinceLastMerge(entries), { entries: [entries[2]], mergedBefore: true });
	assert.deepEqual(entriesSinceLastMerge(entries.slice(0, 1)), { entries: entries.slice(0, 1), mergedBefore: false });
});
