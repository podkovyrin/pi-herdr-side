import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { MAX_PROMPT_BYTES, MERGE_CONTENT_BUDGET_BYTES, MERGE_CUSTOM_TYPE, MERGE_FILE_PREFIX } from "./constants.ts";
import { isSafePathPart, textOf, withoutSummaryTurns } from "./store.ts";
import { tailBytes } from "./text.ts";

export type MergeMode = "transcript" | "summary";

export interface MergeRequest {
	version: 1;
	requestId: string;
	chatId: string;
	parentSessionId: string;
	createdAt: string;
	mode: MergeMode;
	title: string;
	content: string;
	prompt: string;
}

export interface MergeDetails {
	requestId: string;
	chatId: string;
	mode: MergeMode;
	title: string;
}

const OMITTED = "[Earlier side-chat turns omitted to fit the merge budget.]";

const byteLength = (text: string) => Buffer.byteLength(text, "utf8");

export function isPromptWithinBounds(prompt: string): boolean {
	const trimmed = prompt.trim();
	return trimmed.length > 0 && byteLength(trimmed) <= MAX_PROMPT_BYTES;
}

export function isMergeRequest(value: unknown): value is MergeRequest {
	const request = value as Partial<MergeRequest> | undefined;
	return (
		!!request &&
		request.version === 1 &&
		typeof request.requestId === "string" &&
		isSafePathPart(request.requestId) &&
		typeof request.chatId === "string" &&
		typeof request.parentSessionId === "string" &&
		typeof request.createdAt === "string" &&
		(request.mode === "transcript" || request.mode === "summary") &&
		typeof request.title === "string" &&
		typeof request.content === "string" &&
		request.content.trim().length > 0 &&
		byteLength(request.content) <= MERGE_CONTENT_BUDGET_BYTES + 1024 &&
		typeof request.prompt === "string" &&
		isPromptWithinBounds(request.prompt)
	);
}

function textBlocks(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

/**
 * User and assistant text from side-chat entries. Tool calls, tool results,
 * thinking, and earlier summary turns are left out. Over budget, whole turns
 * drop from the start, so the newest findings survive.
 */
export function buildTranscript(
	entries: ReadonlyArray<Record<string, unknown>>,
	budgetBytes = MERGE_CONTENT_BUDGET_BYTES,
): string | undefined {
	const turns: string[] = [];
	for (const entry of withoutSummaryTurns(entries)) {
		if (entry.type !== "message") continue;
		const message = entry.message as { role?: unknown; content?: unknown } | undefined;
		if (message?.role !== "user" && message?.role !== "assistant") continue;
		const text = textBlocks(message.content);
		if (text) turns.push(`${message.role === "user" ? "User" : "Assistant"}:\n${text}`);
	}
	if (turns.length === 0) return undefined;

	const kept: string[] = [];
	let used = 0;
	for (let index = turns.length - 1; index >= 0; index -= 1) {
		const turn = turns[index] as string;
		const size = byteLength(turn) + 2;
		if (used + size > budgetBytes) {
			kept.unshift(kept.length === 0 ? `${OMITTED}\n${tailBytes(turn, budgetBytes - byteLength(OMITTED) - 1)}` : OMITTED);
			break;
		}
		kept.unshift(turn);
		used += size;
	}
	return kept.join("\n\n");
}

/** The latest assistant text in the entries. */
export function lastAssistantText(entries: ReadonlyArray<Record<string, unknown>>): string | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index] as Record<string, unknown>;
		if (entry.type !== "message") continue;
		const message = entry.message as { role?: unknown; content?: unknown; stopReason?: unknown } | undefined;
		if (message?.role !== "assistant") continue;
		if (message.stopReason === "error" || message.stopReason === "aborted") return undefined;
		const text = textBlocks(message.content);
		if (text) return tailBytes(text, MERGE_CONTENT_BUDGET_BYTES);
	}
	return undefined;
}

/**
 * The reply to one summary prompt: assistant text after the last user entry
 * with exactly that prompt, up to the next user message. Earlier side-chat
 * answers never count as the summary.
 */
export function summaryReplyText(entries: ReadonlyArray<Record<string, unknown>>, prompt: string): string | undefined {
	const isUser = (entry: Record<string, unknown>) =>
		entry.type === "message" && (entry.message as { role?: unknown } | undefined)?.role === "user";
	const start = entries.findLastIndex(
		(entry) => isUser(entry) && textOf((entry.message as { content?: unknown }).content).trim() === prompt.trim(),
	);
	if (start === -1) return undefined;
	const rest = entries.slice(start + 1);
	const end = rest.findIndex(isUser);
	return lastAssistantText(end === -1 ? rest : rest.slice(0, end));
}

export function buildMergeMessage(request: MergeRequest): string {
	const label = request.mode === "summary" ? "summary" : "transcript";
	return [
		`Merged from side chat "${request.title}" (${label}). This side chat was forked from this session and ran separately.`,
		"",
		"<side-chat>",
		request.content.trim(),
		"</side-chat>",
	].join("\n");
}

export function mergeDetailsOf(value: unknown): MergeDetails | undefined {
	const details = value as Partial<MergeDetails> | undefined;
	return details && typeof details.requestId === "string" ? (details as MergeDetails) : undefined;
}

/** Request IDs already present in the main session, so a crash between append and cleanup cannot double-deliver. */
export function deliveredRequestIds(entries: ReadonlyArray<Record<string, unknown>>): Set<string> {
	const ids = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "custom_message" || entry.customType !== MERGE_CUSTOM_TYPE) continue;
		const details = mergeDetailsOf(entry.details);
		if (details) ids.add(details.requestId);
	}
	return ids;
}

export interface PendingMerge {
	path: string;
	request: MergeRequest;
}

/** Find merge requests in every chat directory of one main session. Invalid files are removed. */
export async function findPendingMerges(dir: string, parentSessionId: string): Promise<PendingMerge[]> {
	let chatNames: string[];
	try {
		chatNames = await readdir(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const pending: PendingMerge[] = [];
	for (const chatName of chatNames.filter(isSafePathPart)) {
		const chatDir = join(dir, chatName);
		let files: string[];
		try {
			files = await readdir(chatDir);
		} catch {
			continue;
		}
		for (const file of files) {
			if (!file.startsWith(MERGE_FILE_PREFIX) || !file.endsWith(".json")) continue;
			const path = join(chatDir, file);
			let value: unknown;
			try {
				value = JSON.parse(await readFile(path, "utf8"));
			} catch {
				continue;
			}
			if (!isMergeRequest(value) || value.parentSessionId !== parentSessionId) {
				await rm(path, { force: true }).catch(() => undefined);
				continue;
			}
			pending.push({ path, request: value });
		}
	}
	return pending.sort((a, b) => a.request.createdAt.localeCompare(b.request.createdAt));
}
