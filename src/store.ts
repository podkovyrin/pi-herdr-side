import { randomBytes } from "node:crypto";
import { mkdir, open, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	isSummaryPrompt,
	MERGE_FILE_PREFIX,
	MERGED_MARKER_TYPE,
	META_FILE,
	NOTE_CUSTOM_TYPE,
	PANE_FILE,
	PARENT_FILE,
} from "./constants.ts";
import type { EntryLike } from "./fork.ts";
import { toTitle } from "./text.ts";

export interface ChatMeta {
	version: 1;
	chatId: string;
	parentSessionId: string;
	parentSessionFile: string | null;
	cwd: string;
	createdAt: string;
	/** Session file name inside the chat directory. */
	sessionFileName: string;
	/** ID of the hidden note entry. Side-chat turns start after it. */
	noteEntryId: string;
	/**
	 * Byte offset of the note line in the session file, so listing chats can
	 * skip the forked main history. Optional: older metas lack it, and pi may
	 * rewrite the file, so readers verify it and fall back to a full parse.
	 */
	noteByteOffset?: number;
	/**
	 * Tools for the side chat, as passed to `--tools` at the start. Resume
	 * passes them again, since pi does not restore tools from the session.
	 * Optional: older metas lack it.
	 */
	tools?: string[];
}

export interface LiveMarker {
	pid: number;
	paneId: string;
}

/** pi session IDs use letters, digits, `.`, `_`, and `-`. Refuse anything else as a path part. */
export function isSafePathPart(value: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && !value.includes("..");
}

export function parentDir(root: string, parentSessionId: string): string {
	if (!isSafePathPart(parentSessionId)) throw new Error(`Unsupported session ID: ${parentSessionId}`);
	return join(root, parentSessionId);
}

export function newChatId(now = Date.now()): string {
	return `${now.toString(36)}-${randomBytes(3).toString("hex")}`;
}

export async function ensurePrivateDir(dir: string): Promise<void> {
	await mkdir(dir, { recursive: true, mode: 0o700 });
}

/** Write through a temporary file and rename, so readers never see a partial file. */
export async function writeFileAtomic(path: string, content: string, mode = 0o600): Promise<void> {
	const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode });
		await rename(temporary, path);
	} catch (error) {
		await rm(temporary, { force: true }).catch(() => undefined);
		throw error;
	}
}

export async function writeJson(path: string, value: unknown): Promise<void> {
	await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readJson(path: string): Promise<unknown | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as unknown;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/** A tool name pi can take in a comma-separated `--tools` list. */
export const isToolName = (value: unknown): value is string => typeof value === "string" && value.length > 0 && !/[,\s]/.test(value);

export function isChatMeta(value: unknown): value is ChatMeta {
	const meta = value as Partial<ChatMeta> | undefined;
	return (
		!!meta &&
		meta.version === 1 &&
		typeof meta.chatId === "string" &&
		isSafePathPart(meta.chatId) &&
		typeof meta.parentSessionId === "string" &&
		(meta.parentSessionFile === null || typeof meta.parentSessionFile === "string") &&
		typeof meta.cwd === "string" &&
		typeof meta.createdAt === "string" &&
		typeof meta.sessionFileName === "string" &&
		isSafePathPart(meta.sessionFileName) &&
		typeof meta.noteEntryId === "string" &&
		(meta.noteByteOffset === undefined || (Number.isSafeInteger(meta.noteByteOffset) && meta.noteByteOffset >= 0)) &&
		(meta.tools === undefined || (Array.isArray(meta.tools) && meta.tools.every(isToolName)))
	);
}

export async function readMeta(chatDir: string): Promise<ChatMeta | undefined> {
	const value = await readJson(join(chatDir, META_FILE));
	return isChatMeta(value) ? value : undefined;
}

export function isPidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function isLiveMarker(value: unknown): value is LiveMarker {
	const marker = value as Partial<LiveMarker> | undefined;
	return !!marker && typeof marker.pid === "number" && typeof marker.paneId === "string" && marker.paneId.length > 0;
}

/** A marker counts only while its process is alive; stale markers from crashes are ignored. */
export async function readLiveMarker(path: string): Promise<LiveMarker | undefined> {
	const value = await readJson(path).catch(() => undefined);
	return isLiveMarker(value) && isPidAlive(value.pid) ? value : undefined;
}

export async function writeLiveMarker(path: string, paneId: string): Promise<void> {
	await writeJson(path, { pid: process.pid, paneId } satisfies LiveMarker);
}

/** Remove a marker only if this process wrote it. Another process may own it now. */
export async function removeOwnLiveMarker(path: string): Promise<void> {
	const value = await readJson(path).catch(() => undefined);
	if (isLiveMarker(value) && value.pid === process.pid) await rm(path, { force: true });
}

export const chatPaths = (chatDir: string) => ({
	meta: join(chatDir, META_FILE),
	pane: join(chatDir, PANE_FILE),
});

export const parentMarkerPath = (dir: string) => join(dir, PARENT_FILE);

export function parseJsonl(content: string): Array<Record<string, unknown>> {
	const entries: Array<Record<string, unknown>> = [];
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		try {
			entries.push(JSON.parse(line) as Record<string, unknown>);
		} catch {
			// A torn last line from a crash. Skip it.
		}
	}
	return entries;
}

export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

/**
 * Drop the summary turns that summary merges add: the prompt and every
 * message after it until the next user message. Other entries stay.
 */
export function withoutSummaryTurns<T extends Record<string, unknown>>(entries: readonly T[]): T[] {
	const kept: T[] = [];
	let inSummary = false;
	for (const entry of entries) {
		if (entry.type === "message") {
			const message = entry.message as { role?: unknown; content?: unknown } | undefined;
			if (message?.role === "user") inSummary = isSummaryPrompt(textOf(message.content));
			if (inSummary) continue;
		}
		kept.push(entry);
	}
	return kept;
}

/**
 * The side chat's own name: the latest session_info after the note. The fork
 * copies the main session's session_info entries, so earlier ones are the main
 * session's name. An empty name clears it, as in pi.
 */
export function sideChatName(entries: ReadonlyArray<Record<string, unknown>>, noteEntryId: string): string | undefined {
	let name: string | undefined;
	for (const entry of entriesAfterNote(entries, noteEntryId)) {
		if (entry.type === "session_info") name = typeof entry.name === "string" ? entry.name.trim() || undefined : undefined;
	}
	return name;
}

export interface ChatSummary {
	meta: ChatMeta;
	dir: string;
	sessionFile: string;
	title: string;
	questions: number;
	/** Messages after the note. Zero means the side chat never ran a turn. */
	messages: number;
	updatedAt: number;
	openPaneId?: string;
}

/** Title and counts come from entries after the note, so the forked main history is ignored. */
export function summarizeChatEntries(entries: ReadonlyArray<Record<string, unknown>>, noteEntryId: string) {
	const sideEntries = withoutSummaryTurns(entriesAfterNote(entries, noteEntryId));
	let firstQuestion: string | undefined;
	let questions = 0;
	let messages = 0;
	for (const entry of sideEntries) {
		if (entry.type !== "message") continue;
		messages += 1;
		const message = entry.message as { role?: unknown; content?: unknown } | undefined;
		if (message?.role !== "user") continue;
		questions += 1;
		firstQuestion ??= textOf(message.content);
	}
	const title = toTitle(sideChatName(entries, noteEntryId) ?? firstQuestion ?? "") || "Untitled side chat";
	return { title, questions, messages };
}

/**
 * Read the side-chat part of a session file. With a verified note offset only
 * the bytes from the note on are read; each file holds a full copy of the
 * forked main branch, which can be large.
 */
export async function readChatEntries(
	sessionFile: string,
	meta: Pick<ChatMeta, "noteEntryId" | "noteByteOffset">,
): Promise<{ entries: Array<Record<string, unknown>>; mtimeMs: number }> {
	const handle = await open(sessionFile, "r");
	try {
		const info = await handle.stat();
		const readFrom = async (offset: number) => {
			const buffer = Buffer.alloc(Math.max(0, info.size - offset));
			let length = 0;
			while (length < buffer.length) {
				const { bytesRead } = await handle.read(buffer, length, buffer.length - length, offset + length);
				if (bytesRead === 0) break;
				length += bytesRead;
			}
			return buffer.subarray(0, length).toString("utf8");
		};
		const offset = meta.noteByteOffset;
		if (offset !== undefined && offset < info.size) {
			const tail = await readFrom(offset);
			const newline = tail.indexOf("\n");
			try {
				const first = JSON.parse(newline === -1 ? tail : tail.slice(0, newline)) as { id?: unknown };
				if (first.id === meta.noteEntryId) return { entries: parseJsonl(tail), mtimeMs: info.mtimeMs };
			} catch {
				// The offset is stale, for example after pi migrated the file. Parse all of it.
			}
		}
		return { entries: parseJsonl(await readFrom(0)), mtimeMs: info.mtimeMs };
	} finally {
		await handle.close();
	}
}

export interface ListOptions {
	/**
	 * Delete chats that never ran a turn, are not open, and are older than
	 * this. They come from panes that failed to start pi or were closed at once.
	 */
	pruneEmptyAfterMs?: number;
	now?: number;
}

export async function listChats(dir: string, options: ListOptions = {}): Promise<ChatSummary[]> {
	let names: string[];
	try {
		names = await readdir(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const now = options.now ?? Date.now();
	const chats = await Promise.all(
		names.filter(isSafePathPart).map(async (name): Promise<ChatSummary | undefined> => {
			const chatDir = join(dir, name);
			const meta = await readMeta(chatDir).catch(() => undefined);
			if (!meta) return undefined;
			const sessionFile = join(chatDir, meta.sessionFileName);
			try {
				const { entries, mtimeMs } = await readChatEntries(sessionFile, meta);
				const summary = summarizeChatEntries(entries, meta.noteEntryId);
				const marker = await readLiveMarker(chatPaths(chatDir).pane);
				const chat: ChatSummary = { meta, dir: chatDir, sessionFile, ...summary, updatedAt: mtimeMs, openPaneId: marker?.paneId };
				if (options.pruneEmptyAfterMs !== undefined && isAbandoned(chat, now, options.pruneEmptyAfterMs)) {
					await rm(chatDir, { recursive: true, force: true }).catch(() => undefined);
					return undefined;
				}
				return chat;
			} catch {
				return undefined;
			}
		}),
	);
	return chats
		.filter((chat): chat is ChatSummary => chat !== undefined)
		.sort((a, b) => b.updatedAt - a.updatedAt);
}

function isAbandoned(chat: ChatSummary, now: number, minAgeMs: number): boolean {
	if (chat.messages > 0 || chat.openPaneId) return false;
	const created = Date.parse(chat.meta.createdAt);
	const newest = Math.max(chat.updatedAt, Number.isNaN(created) ? 0 : created);
	return now - newest > minAgeMs;
}

/** Entries on the side-chat branch after the hidden note. */
export function entriesAfterNote<T extends { id?: unknown }>(branch: readonly T[], noteEntryId: string): T[] {
	const index = branch.findIndex((entry) => entry.id === noteEntryId);
	if (index === -1) return [];
	return branch.slice(index + 1);
}

/**
 * The chat directory for a session file at `<root>/<main session ID>/<chat ID>/<file>`.
 * Pure path check; the caller verifies meta.json.
 */
export function sideChatDirOf(sessionFile: string, root: string): string | undefined {
	const base = resolve(root);
	const parts = relative(base, resolve(sessionFile)).split(sep);
	if (parts.length !== 3 || !parts.every(isSafePathPart)) return undefined;
	return join(base, parts[0] as string, parts[1] as string);
}

export function isInsideDir(path: string, dir: string): boolean {
	const rel = relative(resolve(dir), resolve(path));
	return rel.length > 0 && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Find the side chat a session file belongs to, without the --side-chat flag.
 * Herdr restores panes and users resume files as plain `pi --session <file>`.
 */
export async function detectSideChatDir(sessionFile: string | undefined, root: string): Promise<string | undefined> {
	if (!sessionFile) return undefined;
	const real = async (path: string) => await realpath(path).catch(() => path);
	const dir = sideChatDirOf(sessionFile, root) ?? sideChatDirOf(await real(sessionFile), await real(root));
	if (!dir) return undefined;
	const meta = await readMeta(dir).catch(() => undefined);
	if (!meta || meta.chatId !== basename(dir) || meta.parentSessionId !== basename(dirname(dir))) return undefined;
	return dir;
}

/** Side-chat entries after the last merge marker, so one merge never resends what an earlier one sent. */
export function entriesSinceLastMerge<T extends EntryLike>(entries: readonly T[]): { entries: T[]; mergedBefore: boolean } {
	const index = entries.findLastIndex((entry) => entry.type === "custom" && entry.customType === MERGED_MARKER_TYPE);
	return index === -1 ? { entries: [...entries], mergedBefore: false } : { entries: entries.slice(index + 1), mergedBefore: true };
}

export const isNoteEntry = (entry: Record<string, unknown>) =>
	entry.type === "custom_message" && entry.customType === NOTE_CUSTOM_TYPE;

export const mergeFileName = (requestId: string) => `${MERGE_FILE_PREFIX}${requestId}.json`;
