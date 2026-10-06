import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MERGE_FILE_PREFIX, MERGED_MARKER_TYPE, META_FILE, NOTE_CUSTOM_TYPE, PANE_FILE, PARENT_FILE } from "./constants.ts";
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
		typeof meta.noteEntryId === "string"
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

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

export interface ChatSummary {
	meta: ChatMeta;
	dir: string;
	sessionFile: string;
	title: string;
	questions: number;
	updatedAt: number;
	openPaneId?: string;
}

/** Title and question count come from entries after the note, so the forked main history is ignored. */
export function summarizeChatEntries(entries: ReadonlyArray<Record<string, unknown>>, noteEntryId: string) {
	let name: string | undefined;
	let firstQuestion: string | undefined;
	let questions = 0;
	let afterNote = false;
	for (const entry of entries) {
		if (entry.type === "session_info" && typeof entry.name === "string" && entry.name.trim()) name = entry.name;
		if (entry.id === noteEntryId) {
			afterNote = true;
			continue;
		}
		if (!afterNote || entry.type !== "message") continue;
		const message = entry.message as { role?: unknown; content?: unknown } | undefined;
		if (message?.role !== "user") continue;
		questions += 1;
		firstQuestion ??= textOf(message.content);
	}
	const title = toTitle(name ?? firstQuestion ?? "") || "Untitled side chat";
	return { title, questions };
}

export async function listChats(dir: string): Promise<ChatSummary[]> {
	let names: string[];
	try {
		names = await readdir(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const chats = await Promise.all(
		names.filter(isSafePathPart).map(async (name): Promise<ChatSummary | undefined> => {
			const chatDir = join(dir, name);
			const meta = await readMeta(chatDir).catch(() => undefined);
			if (!meta) return undefined;
			const sessionFile = join(chatDir, meta.sessionFileName);
			try {
				const [content, info] = await Promise.all([readFile(sessionFile, "utf8"), stat(sessionFile)]);
				const summary = summarizeChatEntries(parseJsonl(content), meta.noteEntryId);
				const marker = await readLiveMarker(chatPaths(chatDir).pane);
				return { meta, dir: chatDir, sessionFile, ...summary, updatedAt: info.mtimeMs, openPaneId: marker?.paneId };
			} catch {
				return undefined;
			}
		}),
	);
	return chats
		.filter((chat): chat is ChatSummary => chat !== undefined)
		.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Entries on the side-chat branch after the hidden note. */
export function entriesAfterNote<T extends EntryLike>(branch: readonly T[], noteEntryId: string): T[] {
	const index = branch.findIndex((entry) => entry.id === noteEntryId);
	if (index === -1) return [];
	return branch.slice(index + 1);
}

/** Side-chat entries after the last merge marker, so one merge never resends what an earlier one sent. */
export function entriesSinceLastMerge<T extends EntryLike>(entries: readonly T[]): { entries: T[]; mergedBefore: boolean } {
	const index = entries.findLastIndex((entry) => entry.type === "custom" && entry.customType === MERGED_MARKER_TYPE);
	return index === -1 ? { entries: [...entries], mergedBefore: false } : { entries: entries.slice(index + 1), mergedBefore: true };
}

export const isNoteEntry = (entry: Record<string, unknown>) =>
	entry.type === "custom_message" && entry.customType === NOTE_CUSTOM_TYPE;

export const mergeFileName = (requestId: string) => `${MERGE_FILE_PREFIX}${requestId}.json`;
