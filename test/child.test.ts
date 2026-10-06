import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SideChatChild } from "../src/child.ts";
import { MERGED_MARKER_TYPE, summaryPrompt } from "../src/constants.ts";
import type { Herdr } from "../src/herdr.ts";
import { type ChatMeta, ensurePrivateDir, writeJson, writeLiveMarker } from "../src/store.ts";

type Entry = Record<string, unknown> & { type: string; id: string; parentId: string | null };

const NOTE_ID = "note0001";

/** A side chat on disk, a fake pi, and a fake command context. */
async function setup(
	options: { mode?: "transcript" | "summary"; summary?: "never-starts" | "replies"; detectedByPath?: boolean; tools?: string[] } = {},
) {
	const root = mkdtempSync(join(tmpdir(), "pi-herdr-side-test-"));
	const chatDir = join(root, "main", "chat-1");
	await ensurePrivateDir(chatDir);
	const meta: ChatMeta = {
		version: 1, chatId: "chat-1", parentSessionId: "main", parentSessionFile: null, cwd: "/",
		createdAt: new Date().toISOString(), sessionFileName: "s.jsonl", noteEntryId: NOTE_ID,
		...(options.tools ? { tools: options.tools } : {}),
	};
	await writeJson(join(chatDir, "meta.json"), meta);
	writeFileSync(join(chatDir, "launch.sh"), "#!/bin/sh\n", { mode: 0o700 });

	const entries: Entry[] = [];
	const add = (entry: Omit<Entry, "parentId">) => entries.push({ ...entry, parentId: entries.at(-1)?.id ?? null } as Entry);
	add({ type: "session_info", id: "i0", name: "Main name" });
	add({ type: "message", id: "m1", message: { role: "user", content: "main question" } });
	add({ type: "custom_message", id: NOTE_ID, customType: "pi-herdr-side.note", content: "N", display: false });
	add({ type: "message", id: "s1", message: { role: "user", content: "Why X?" } });
	add({ type: "message", id: "s2", message: { role: "assistant", content: [{ type: "text", text: "Because Y." }] } });

	const calls = { prompts: [] as string[], marks: [] as unknown[], names: [] as string[], notes: [] as string[], focused: [] as string[], shutdown: 0, activeTools: [] as string[][] };
	let child: SideChatChild;
	const pi = {
		sendUserMessage(text: string) {
			calls.prompts.push(text);
			if (options.summary !== "replies") return;
			// A run: start, the prompt and the reply land in the session, then settle.
			setTimeout(() => {
				child.onAgentStart();
				add({ type: "message", id: "s3", message: { role: "user", content: [{ type: "text", text }] } });
				add({ type: "message", id: "s4", message: { role: "assistant", content: [{ type: "text", text: "The summary." }] } });
				child.onAgentSettled();
			}, 5);
		},
		appendEntry(customType: string, data: unknown) {
			calls.marks.push({ customType, data });
			add({ type: "custom", id: `mark${calls.marks.length}`, customType, data });
		},
		setSessionName(name: string) {
			calls.names.push(name);
		},
		setActiveTools(names: string[]) {
			calls.activeTools.push(names);
		},
	};
	const ctx = {
		mode: "print",
		cwd: "/",
		isIdle: () => true,
		sessionManager: { getBranch: () => [...entries], getEntries: () => [...entries] },
		ui: {
			notify: (message: string) => calls.notes.push(message),
			editor: async () => undefined,
			select: async (_title: string, choices: string[]) => (options.mode === "summary" ? choices[1] : choices[0]),
			setStatus: () => undefined,
		},
		shutdown: () => {
			calls.shutdown += 1;
		},
	} as unknown as ExtensionCommandContext;
	const herdr = { focus: async (paneId: string) => void calls.focused.push(paneId) } as unknown as Herdr;
	child = new SideChatChild(pi as unknown as ExtensionAPI, chatDir, herdr, {
		summaryStartTimeoutMs: 50,
		...(options.detectedByPath ? { detectedByPath: true } : {}),
	});
	await child.onSessionStart(ctx);
	const mergeFiles = () => readdirSync(chatDir).filter((name) => name.startsWith("merge-"));
	return { root, chatDir, entries, add, calls, ctx, child, mergeFiles, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("session start removes launch.sh", async () => {
	const t = await setup();
	try {
		assert.ok(!existsSync(join(t.chatDir, "launch.sh")));
	} finally {
		t.cleanup();
	}
});

test("a side chat found by its path sets the saved tools; one started with the flag does not", async () => {
	const byPath = await setup({ detectedByPath: true, tools: ["read", "codemode"] });
	const flagged = await setup({ tools: ["read", "codemode"] });
	const legacy = await setup({ detectedByPath: true });
	try {
		assert.deepEqual(byPath.calls.activeTools, [["read", "codemode"]]);
		assert.deepEqual(flagged.calls.activeTools, [], "--tools already set them");
		assert.deepEqual(legacy.calls.activeTools, [], "older metas have no tool list");
	} finally {
		byPath.cleanup();
		flagged.cleanup();
		legacy.cleanup();
	}
});

test("a side chat is named after its first question, not after the main session", async () => {
	const t = await setup();
	try {
		t.child.onInput("  side question  ", "interactive", t.ctx);
		assert.deepEqual(t.calls.names, ["side question"]);
		t.child.onInput("from an extension", "extension", t.ctx);
		t.child.onInput("/side", "interactive", t.ctx);
		assert.equal(t.calls.names.length, 1);
		t.add({ type: "session_info", id: "i1", name: "Side name" });
		t.child.onInput("next question", "interactive", t.ctx);
		assert.equal(t.calls.names.length, 1);
	} finally {
		t.cleanup();
	}
});

test("a transcript merge writes a request and a merge marker", async () => {
	const t = await setup({ mode: "transcript" });
	try {
		await t.child.merge("apply it", t.ctx);
		const files = t.mergeFiles();
		assert.equal(files.length, 1);
		const request = JSON.parse(readFileSync(join(t.chatDir, files[0] as string), "utf8"));
		assert.equal(request.mode, "transcript");
		assert.equal(request.content, "User:\nWhy X?\n\nAssistant:\nBecause Y.");
		assert.equal(request.prompt, "apply it");
		assert.equal(request.title, "Why X?", "not the main session's name");
		assert.equal(request.parentSessionId, "main");
		assert.deepEqual(t.calls.marks, [{ customType: MERGED_MARKER_TYPE, data: { requestId: request.requestId } }]);
		// The main session is not running, so the side chat stays open.
		assert.equal(t.calls.shutdown, 0);
		assert.match(t.calls.notes.at(-1) ?? "", /not running/);

		await t.child.merge("again", t.ctx);
		assert.equal(t.mergeFiles().length, 1, "nothing new since the last merge");
	} finally {
		t.cleanup();
	}
});

test("a merge into a running main session focuses its pane and closes the side chat", async () => {
	const t = await setup({ mode: "transcript" });
	try {
		await writeLiveMarker(join(t.root, "main", "parent.json"), "w1:p1");
		await t.child.merge("apply it", t.ctx);
		assert.deepEqual(t.calls.focused, ["w1:p1"]);
		assert.equal(t.calls.shutdown, 1);
	} finally {
		t.cleanup();
	}
});

test("a summary run that never starts merges nothing", async () => {
	const t = await setup({ mode: "summary", summary: "never-starts" });
	try {
		await t.child.merge("apply it", t.ctx);
		assert.deepEqual(t.calls.prompts, [summaryPrompt(false)]);
		assert.deepEqual(t.mergeFiles(), []);
		assert.deepEqual(t.calls.marks, []);
		assert.match(t.calls.notes.at(-1) ?? "", /did not start/);
	} finally {
		t.cleanup();
	}
});

test("a summary merge sends the reply to the summary prompt", async () => {
	const t = await setup({ mode: "summary", summary: "replies" });
	try {
		await t.child.merge("apply it", t.ctx);
		const files = t.mergeFiles();
		assert.equal(files.length, 1);
		const request = JSON.parse(readFileSync(join(t.chatDir, files[0] as string), "utf8"));
		assert.equal(request.mode, "summary");
		assert.equal(request.content, "The summary.");
		assert.equal(request.title, "Why X?");
	} finally {
		t.cleanup();
	}
});
