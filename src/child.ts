import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { LAUNCH_FILE, MAX_PROMPT_BYTES, MERGED_MARKER_TYPE, summaryPrompt } from "./constants.ts";
import type { EntryLike } from "./fork.ts";
import type { Herdr } from "./herdr.ts";
import { buildTranscript, isPromptWithinBounds, type MergeMode, type MergeRequest, summaryReplyText } from "./merge.ts";
import {
	type ChatMeta,
	chatPaths,
	entriesAfterNote,
	entriesSinceLastMerge,
	mergeFileName,
	parentMarkerPath,
	readLiveMarker,
	readMeta,
	removeOwnLiveMarker,
	sideChatName,
	summarizeChatEntries,
	writeJson,
	writeLiveMarker,
} from "./store.ts";
import { toTitle } from "./text.ts";

const STATUS_KEY = "pi-herdr-side";
const MODE_TRANSCRIPT = "Transcript: side-chat questions and answers, without tool output";
const MODE_SUMMARY = "Summary: the side chat writes a summary first (one more turn)";

export interface ChildOptions {
	/** How long pi may stay idle after the summary prompt before the merge gives up. */
	summaryStartTimeoutMs?: number;
	/**
	 * Found by its session file path, without --side-chat: Herdr restored the
	 * pane, or the user ran `pi --session <file>`. No --tools was passed then.
	 */
	detectedByPath?: boolean;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs inside a side-chat pi process (started with --side-chat <dir>, or on a side-chat session file). */
export class SideChatChild {
	private meta: ChatMeta | undefined;
	private settleWaiters: Array<() => void> = [];
	private startWaiters: Array<() => void> = [];
	private stopped = false;

	private readonly pi: ExtensionAPI;
	private readonly chatDir: string;
	private readonly herdr: Herdr;
	private readonly summaryStartTimeoutMs: number;
	private readonly detectedByPath: boolean;

	constructor(pi: ExtensionAPI, chatDir: string, herdr: Herdr, options: ChildOptions = {}) {
		this.pi = pi;
		this.chatDir = chatDir;
		this.herdr = herdr;
		this.summaryStartTimeoutMs = options.summaryStartTimeoutMs ?? 5_000;
		this.detectedByPath = options.detectedByPath ?? false;
	}

	async onSessionStart(ctx: ExtensionContext): Promise<void> {
		// sh has already replaced itself with pi. The script holds the forwarded environment, so do not keep it.
		await rm(join(this.chatDir, LAUNCH_FILE), { force: true }).catch(() => undefined);
		this.meta = await readMeta(this.chatDir).catch(() => undefined);
		if (!this.meta) {
			ctx.ui.notify(`pi-herdr-side: no side chat metadata in ${this.chatDir}`, "error");
			return;
		}
		// pi does not restore tools from the session file. With the flag, --tools already set them.
		if (this.detectedByPath && this.meta.tools) this.pi.setActiveTools(this.meta.tools);
		const paneId = process.env.HERDR_PANE_ID;
		if (paneId) await writeLiveMarker(chatPaths(this.chatDir).pane, paneId).catch(() => undefined);
		if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", "side chat · /side merges it back"));
	}

	async onSessionShutdown(): Promise<void> {
		this.stopped = true;
		this.releaseStartWaiters();
		this.releaseSettleWaiters();
		await removeOwnLiveMarker(chatPaths(this.chatDir).pane).catch(() => undefined);
	}

	onAgentStart(): void {
		this.releaseStartWaiters();
	}

	onAgentSettled(): void {
		this.releaseSettleWaiters();
	}

	/**
	 * Name an unnamed side chat after its first question; the name is the Resume
	 * title. pi.getSessionName() would return the main session's name, which the
	 * fork copies, so only names after the note count.
	 */
	onInput(text: string, source: string, ctx: ExtensionContext): void {
		const meta = this.meta;
		if (source === "extension" || !meta) return;
		const entries = ctx.sessionManager.getEntries() as unknown as Array<Record<string, unknown>>;
		if (sideChatName(entries, meta.noteEntryId)) return;
		const trimmed = text.trim();
		if (!trimmed || trimmed.startsWith("/")) return;
		this.pi.setSessionName(toTitle(trimmed));
	}

	private releaseSettleWaiters(): void {
		const waiters = this.settleWaiters;
		this.settleWaiters = [];
		for (const resolve of waiters) resolve();
	}

	private releaseStartWaiters(): void {
		const waiters = this.startWaiters;
		this.startWaiters = [];
		for (const resolve of waiters) resolve();
	}

	private nextSettle(): Promise<void> {
		return new Promise((resolve) => this.settleWaiters.push(resolve));
	}

	private nextStart(): Promise<void> {
		return new Promise((resolve) => this.startWaiters.push(resolve));
	}

	/**
	 * pi.sendUserMessage() does not report failures. pi can return or throw
	 * before any run starts: no model, no auth, or an input handler that took
	 * the text. Then no agent_settled follows, and waiting for it would hang
	 * until an unrelated run. So give up when pi stays idle without a run start.
	 */
	private async waitForRunStart(started: Promise<void>, ctx: ExtensionContext): Promise<boolean> {
		let didStart = false;
		void started.then(() => {
			didStart = true;
		});
		let idleSince = Date.now();
		const interval = Math.min(100, this.summaryStartTimeoutMs);
		for (;;) {
			await sleep(interval);
			if (didStart) return true;
			if (this.stopped) return false;
			// Busy without a run start, for example a compaction before the prompt. Keep waiting.
			if (!ctx.isIdle()) idleSince = Date.now();
			else if (Date.now() - idleSince >= this.summaryStartTimeoutMs) return false;
		}
	}

	/** Run one summary turn and return its text, or undefined after telling the user why not. */
	private async runSummary(ctx: ExtensionCommandContext, meta: ChatMeta, mergedBefore: boolean): Promise<string | undefined> {
		const prompt = summaryPrompt(mergedBefore);
		// Register both waiters first: a run that fails at once can start and settle within one poll.
		const started = this.nextStart();
		const settled = this.nextSettle();
		this.pi.sendUserMessage(prompt);
		if (!(await this.waitForRunStart(started, ctx))) {
			if (!this.stopped) ctx.ui.notify("The summary turn did not start. Nothing was merged.", "error");
			return undefined;
		}
		await settled;
		if (this.stopped) return undefined;
		const summary = summaryReplyText(this.unmergedEntries(ctx, meta).entries, prompt);
		if (!summary) ctx.ui.notify("The summary turn did not produce text. Nothing was merged.", "error");
		return summary;
	}

	/** Side-chat entries not merged yet: after the note and after the last merge marker. */
	private unmergedEntries(ctx: ExtensionCommandContext, meta: ChatMeta) {
		return entriesSinceLastMerge(entriesAfterNote(ctx.sessionManager.getBranch() as unknown as EntryLike[], meta.noteEntryId));
	}

	async merge(args: string, ctx: ExtensionCommandContext): Promise<void> {
		const meta = this.meta;
		if (!meta) {
			ctx.ui.notify("Merge is unavailable: this side chat has no metadata", "error");
			return;
		}
		if (!ctx.isIdle()) {
			ctx.ui.notify("Wait until the side chat finishes, then run /side again", "warning");
			return;
		}
		const unmerged = this.unmergedEntries(ctx, meta);
		const transcript = buildTranscript(unmerged.entries);
		if (!transcript) {
			ctx.ui.notify(
				unmerged.mergedBefore
					? "Nothing new to merge since the last merge"
					: "Nothing to merge: this side chat has no turns yet",
				"warning",
			);
			return;
		}

		const prompt = args.trim() || (await ctx.ui.editor("Prompt for the main session after the merge", ""))?.trim() || "";
		if (!prompt) {
			ctx.ui.notify("Merge cancelled", "info");
			return;
		}
		if (!isPromptWithinBounds(prompt)) {
			ctx.ui.notify(`The prompt must be at most ${MAX_PROMPT_BYTES / 1024} KiB`, "error");
			return;
		}
		const choice = await ctx.ui.select("Merge this side chat into the main session as", [MODE_TRANSCRIPT, MODE_SUMMARY]);
		if (!choice) {
			ctx.ui.notify("Merge cancelled", "info");
			return;
		}
		const mode: MergeMode = choice === MODE_SUMMARY ? "summary" : "transcript";

		let content = transcript;
		if (mode === "summary") {
			const summary = await this.runSummary(ctx, meta, unmerged.mergedBefore);
			if (!summary) return;
			content = summary;
		}

		const entries = ctx.sessionManager.getEntries() as unknown as Array<Record<string, unknown>>;
		const request: MergeRequest = {
			version: 1,
			requestId: randomUUID(),
			chatId: meta.chatId,
			parentSessionId: meta.parentSessionId,
			createdAt: new Date().toISOString(),
			mode,
			title: summarizeChatEntries(entries, meta.noteEntryId).title,
			content,
			prompt,
		};
		try {
			await writeJson(join(this.chatDir, mergeFileName(request.requestId)), request);
		} catch (error) {
			ctx.ui.notify(`Merge failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}
		this.pi.appendEntry(MERGED_MARKER_TYPE, { requestId: request.requestId });

		const parent = await readLiveMarker(parentMarkerPath(dirname(this.chatDir)));
		if (!parent) {
			ctx.ui.notify("The main session is not running. The merge is saved and arrives when you resume it.", "info");
			return;
		}
		await this.herdr.focus(parent.paneId).catch(() => undefined);
		ctx.shutdown();
	}
}
