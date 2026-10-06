import { randomBytes } from "node:crypto";
import { NOTE_CUSTOM_TYPE } from "./constants.ts";

/** Minimal shape of a pi session entry. Other fields are copied unchanged. */
export interface EntryLike {
	type: string;
	id: string;
	parentId: string | null;
	timestamp?: string;
	[key: string]: unknown;
}

export interface ForkInput {
	/** Session ID of the main session. The fork reuses it so provider cache keys match. */
	sessionId: string;
	sessionVersion: number;
	cwd: string;
	/** Main session file, if the main session is persisted. */
	parentSessionFile?: string;
	/** Root-to-leaf branch of the main session, as returned by SessionManager.getBranch(). */
	branch: readonly EntryLike[];
	note: string;
	/** Optional display name, written as a session_info entry. */
	name?: string;
	now: Date;
}

export interface ForkOutput {
	fileName: string;
	content: string;
	/** ID of the hidden note entry. Side-chat turns start after it. */
	noteEntryId: string;
	/** Byte offset of the note line in content. Listing chats reads from here. */
	noteByteOffset: number;
}

/** pi names session files `<ISO timestamp with - for : and .>_<session id>.jsonl`. */
export function sessionFileName(sessionId: string, now: Date): string {
	return `${now.toISOString().replace(/[:.]/g, "-")}_${sessionId}.jsonl`;
}

function newEntryId(taken: ReadonlySet<string>): string {
	for (;;) {
		const id = randomBytes(4).toString("hex");
		if (!taken.has(id)) return id;
	}
}

/**
 * Build a side-chat session file: the main branch copied unchanged, then a
 * hidden note, then an optional name. Copying the branch unchanged keeps the
 * persisted system prompt and tool state, so the side chat sends the same
 * request prefix as the main session.
 */
export function buildForkSession(input: ForkInput): ForkOutput {
	const header = {
		type: "session",
		version: input.sessionVersion,
		id: input.sessionId,
		timestamp: input.now.toISOString(),
		cwd: input.cwd,
		...(input.parentSessionFile ? { parentSession: input.parentSessionFile } : {}),
	};
	const taken = new Set(input.branch.map((entry) => entry.id));
	const timestamp = input.now.toISOString();
	let parentId = input.branch.at(-1)?.id ?? null;

	const noteEntryId = newEntryId(taken);
	taken.add(noteEntryId);
	const note = {
		type: "custom_message",
		id: noteEntryId,
		parentId,
		timestamp,
		customType: NOTE_CUSTOM_TYPE,
		content: input.note,
		display: false,
	};
	parentId = noteEntryId;

	const lines = [header, ...input.branch].map((value) => JSON.stringify(value));
	const noteByteOffset = Buffer.byteLength(`${lines.join("\n")}\n`, "utf8");
	lines.push(JSON.stringify(note));
	if (input.name) {
		const infoId = newEntryId(taken);
		lines.push(JSON.stringify({ type: "session_info", id: infoId, parentId, timestamp, name: input.name }));
	}
	return {
		fileName: sessionFileName(input.sessionId, input.now),
		content: `${lines.join("\n")}\n`,
		noteEntryId,
		noteByteOffset,
	};
}
