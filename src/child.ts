import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MAX_PROMPT_BYTES, MERGED_MARKER_TYPE, summaryPrompt } from "./constants.ts";
import type { EntryLike } from "./fork.ts";
import { Herdr } from "./herdr.ts";
import { buildTranscript, isPromptWithinBounds, lastAssistantText, type MergeMode, type MergeRequest } from "./merge.ts";
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
	summarizeChatEntries,
	writeJson,
	writeLiveMarker,
} from "./store.ts";
import { toTitle } from "./text.ts";

const STATUS_KEY = "pi-herdr-side";
const MODE_TRANSCRIPT = "Transcript: side-chat questions and answers, without tool output";
const MODE_SUMMARY = "Summary: the side chat writes a summary first (one more turn)";

/** Runs inside a side-chat pi process (started with --side-chat <dir>). */
export class SideChatChild {
	private meta: ChatMeta | undefined;
	private settleWaiters: Array<() => void> = [];

	private readonly pi: ExtensionAPI;
	private readonly chatDir: string;
	private readonly herdr: Herdr;

	constructor(pi: ExtensionAPI, chatDir: string, herdr: Herdr) {
		this.pi = pi;
		this.chatDir = chatDir;
		this.herdr = herdr;
	}

	async onSessionStart(ctx: ExtensionContext): Promise<void> {
		this.meta = await readMeta(this.chatDir).catch(() => undefined);
		if (!this.meta) {
			ctx.ui.notify(`pi-herdr-side: no side chat metadata in ${this.chatDir}`, "error");
			return;
		}
		const paneId = process.env.HERDR_PANE_ID;
		if (paneId) await writeLiveMarker(chatPaths(this.chatDir).pane, paneId).catch(() => undefined);
		if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", "side chat · /side merges it back"));
	}

	async onSessionShutdown(): Promise<void> {
		this.releaseWaiters();
		await removeOwnLiveMarker(chatPaths(this.chatDir).pane).catch(() => undefined);
	}

	onAgentSettled(): void {
		this.releaseWaiters();
	}

	/** Name an unnamed side chat after its first question; the name is the Resume title. */
	onInput(text: string, source: string): void {
		if (source === "extension" || this.pi.getSessionName()) return;
		const trimmed = text.trim();
		if (!trimmed || trimmed.startsWith("/")) return;
		this.pi.setSessionName(toTitle(trimmed));
	}

	private releaseWaiters(): void {
		const waiters = this.settleWaiters;
		this.settleWaiters = [];
		for (const resolve of waiters) resolve();
	}

	private nextSettle(): Promise<void> {
		return new Promise((resolve) => this.settleWaiters.push(resolve));
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
			const settled = this.nextSettle();
			this.pi.sendUserMessage(summaryPrompt(unmerged.mergedBefore));
			await settled;
			const summary = lastAssistantText(this.unmergedEntries(ctx, meta).entries);
			if (!summary) {
				ctx.ui.notify("The summary turn did not produce text. Nothing was merged.", "error");
				return;
			}
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
