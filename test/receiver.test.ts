import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MERGE_CUSTOM_TYPE } from "../src/constants.ts";
import type { MergeRequest } from "../src/merge.ts";
import { MergeReceiver, type ReceiverApi, type ReceiverContext } from "../src/receiver.ts";

const request = (requestId: string, createdAt: string): MergeRequest => ({
	version: 1,
	requestId,
	chatId: "chat-1",
	parentSessionId: "main",
	createdAt,
	mode: "transcript",
	title: `Chat ${requestId}`,
	content: `User:\nquestion ${requestId}`,
	prompt: `apply ${requestId}`,
});

/** A main session with a mailbox dir and a fake pi that records what the receiver sends. */
function setup(options: { appendWhenSent?: boolean } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pi-herdr-side-test-"));
	mkdirSync(join(dir, "chat-1"));
	const entries: Array<Record<string, unknown>> = [];
	const state = { idle: true, pendingMessages: false };
	const messages: Array<{ customType: string; details: unknown; triggerTurn: unknown }> = [];
	const prompts: string[] = [];
	const pi = {
		sendMessage(message: { customType: string; details?: unknown }, sendOptions?: { triggerTurn?: boolean }) {
			messages.push({ customType: message.customType, details: message.details, triggerTurn: sendOptions?.triggerTurn });
			// pi appends synchronously while idle.
			if (options.appendWhenSent !== false) entries.push({ type: "custom_message", customType: message.customType, details: message.details });
		},
		sendUserMessage(text: string) {
			prompts.push(text);
		},
	};
	const ctx = {
		sessionManager: { getSessionId: () => "main", getEntries: () => entries },
		isIdle: () => state.idle,
		hasPendingMessages: () => state.pendingMessages,
		ui: { notify: () => undefined },
	};
	const receiver = new MergeReceiver(pi as unknown as ReceiverApi, dir, ctx as unknown as ReceiverContext);
	const mailbox = (id: string, createdAt = "2026-10-06T10:00:00.000Z") => {
		const path = join(dir, "chat-1", `merge-${id}.json`);
		writeFileSync(path, JSON.stringify(request(id, createdAt)));
		return path;
	};
	const cleanup = () => {
		receiver.stop();
		rmSync(dir, { recursive: true, force: true });
	};
	return { dir, entries, state, messages, prompts, receiver, mailbox, cleanup };
}

test("delivers one merge per scan when idle and removes its file", async () => {
	const t = setup();
	try {
		const first = t.mailbox("r1", "2026-10-06T10:00:00.000Z");
		const second = t.mailbox("r2", "2026-10-06T11:00:00.000Z");
		await t.receiver.scan();
		assert.deepEqual(t.prompts, ["apply r1"]);
		assert.equal(t.messages.length, 1);
		assert.equal(t.messages[0]?.customType, MERGE_CUSTOM_TYPE);
		assert.equal(t.messages[0]?.triggerTurn, false);
		assert.ok(!existsSync(first));
		assert.ok(existsSync(second));
		await t.receiver.scan();
		assert.deepEqual(t.prompts, ["apply r1", "apply r2"]);
		assert.ok(!existsSync(second));
		await t.receiver.scan();
		assert.equal(t.messages.length, 2);
	} finally {
		t.cleanup();
	}
});

test("skips while the agent is busy, input is queued, or a dialog is open", async () => {
	const t = setup();
	try {
		const path = t.mailbox("r1");
		t.state.idle = false;
		await t.receiver.scan();
		t.state.idle = true;
		t.state.pendingMessages = true;
		await t.receiver.scan();
		t.state.pendingMessages = false;
		t.receiver.onUIPromptStart();
		await t.receiver.scan();
		assert.equal(t.messages.length, 0);
		assert.ok(existsSync(path));
		// Overlapping dialogs: one closing does not hide the other.
		t.receiver.onUIPromptStart();
		t.receiver.onUIPromptEnd();
		await t.receiver.scan();
		assert.equal(t.messages.length, 0);
		t.receiver.onUIPromptEnd();
		// An extra end never lets the count go below zero.
		t.receiver.onUIPromptEnd();
		await t.receiver.scan();
		assert.deepEqual(t.prompts, ["apply r1"]);
		t.mailbox("r2");
		t.receiver.onUIPromptStart();
		await t.receiver.scan();
		assert.equal(t.messages.length, 1, "one start after extra ends still blocks");
	} finally {
		t.cleanup();
	}
});

test("a merge already in the session is not delivered again", async () => {
	const t = setup();
	try {
		const path = t.mailbox("r1");
		t.entries.push({ type: "custom_message", customType: MERGE_CUSTOM_TYPE, details: { requestId: "r1" } });
		await t.receiver.scan();
		assert.equal(t.messages.length, 0);
		assert.ok(!existsSync(path));
	} finally {
		t.cleanup();
	}
});

test("a deferred append keeps the file but is not sent twice", async () => {
	const t = setup({ appendWhenSent: false });
	try {
		const path = t.mailbox("r1");
		await t.receiver.scan();
		assert.equal(t.messages.length, 1);
		assert.ok(existsSync(path), "the file stays until the message is in the session");
		await t.receiver.scan();
		assert.equal(t.messages.length, 1);
		t.entries.push({ type: "custom_message", customType: MERGE_CUSTOM_TYPE, details: { requestId: "r1" } });
		await t.receiver.scan();
		assert.ok(!existsSync(path));
	} finally {
		t.cleanup();
	}
});
