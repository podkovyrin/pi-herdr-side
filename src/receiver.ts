import { watch, type FSWatcher } from "node:fs";
import { rm } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MERGE_CUSTOM_TYPE } from "./constants.ts";
import { buildMergeMessage, deliveredRequestIds, findPendingMerges, type PendingMerge } from "./merge.ts";
import { ensurePrivateDir } from "./store.ts";

/** The parts of pi the receiver uses, so tests can pass fakes. */
export type ReceiverApi = Pick<ExtensionAPI, "sendMessage" | "sendUserMessage">;
export type ReceiverContext = Pick<ExtensionContext, "sessionManager" | "isIdle" | "hasPendingMessages" | "ui">;

/**
 * Receives merges for one main session. Watches the session's side-chat
 * directory and delivers one request per idle period: the merged content as a
 * visible custom message, then the user's prompt as a new turn.
 */
export class MergeReceiver {
	private watcher: FSWatcher | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private scanning = false;
	private rescan = false;
	private stopped = false;
	/** Open dialogs. A counter, so one dialog closing does not hide another that is still open. */
	private openPrompts = 0;
	/**
	 * Requests sent by this process. If pi deferred the append, the merge is not
	 * in the session entries yet, and this set keeps it from being sent twice.
	 */
	private readonly sent = new Set<string>();

	private readonly pi: ReceiverApi;
	private readonly dir: string;
	private readonly ctx: ReceiverContext;

	constructor(pi: ReceiverApi, dir: string, ctx: ReceiverContext) {
		this.pi = pi;
		this.dir = dir;
		this.ctx = ctx;
	}

	async start(): Promise<void> {
		await ensurePrivateDir(this.dir);
		try {
			this.watcher = watch(this.dir, { recursive: true }, () => this.schedule());
			this.watcher.on("error", () => undefined);
		} catch {
			// Without a watcher, merges still arrive on session start and when the agent settles.
		}
		this.schedule(0);
	}

	stop(): void {
		this.stopped = true;
		this.watcher?.close();
		this.watcher = undefined;
		if (this.timer) clearTimeout(this.timer);
	}

	schedule(delayMs = 150): void {
		if (this.stopped) return;
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => void this.scan(), delayMs);
		this.timer.unref?.();
	}

	/** A dialog is open in the main session. isIdle() is still true, but a merge must not start a turn under it. */
	onUIPromptStart(): void {
		this.openPrompts += 1;
	}

	onUIPromptEnd(): void {
		this.openPrompts = Math.max(0, this.openPrompts - 1);
		if (this.openPrompts === 0) this.schedule(0);
	}

	/** Deliver at most one pending merge. Public for tests; events call schedule(). */
	async scan(): Promise<void> {
		if (this.stopped) return;
		if (this.scanning) {
			this.rescan = true;
			return;
		}
		this.scanning = true;
		try {
			const sessionId = this.ctx.sessionManager.getSessionId();
			const pending = await findPendingMerges(this.dir, sessionId);
			if (pending.length === 0 || this.stopped) return;
			const delivered = this.deliveredIds();
			const next: PendingMerge[] = [];
			for (const merge of pending) {
				if (delivered.has(merge.request.requestId)) await rm(merge.path, { force: true }).catch(() => undefined);
				else if (!this.sent.has(merge.request.requestId)) next.push(merge);
			}
			// Never inject into a running turn, a compaction, queued input, or an open dialog.
			// agent_settled and ui_prompt_end schedule the next scan.
			const first = next[0];
			if (!first || !this.canDeliver()) return;
			await this.deliver(first);
		} catch {
			// A broken mailbox must not break the main session. The next event retries.
		} finally {
			this.scanning = false;
			if (this.rescan) {
				this.rescan = false;
				this.schedule();
			}
		}
	}

	private canDeliver(): boolean {
		return !this.stopped && this.openPrompts === 0 && this.ctx.isIdle() && !this.ctx.hasPendingMessages();
	}

	private deliveredIds(): Set<string> {
		return deliveredRequestIds(this.ctx.sessionManager.getEntries() as unknown as Array<Record<string, unknown>>);
	}

	private async deliver({ path, request }: PendingMerge): Promise<void> {
		this.sent.add(request.requestId);
		this.pi.sendMessage(
			{
				customType: MERGE_CUSTOM_TYPE,
				content: buildMergeMessage(request),
				display: true,
				details: { requestId: request.requestId, chatId: request.chatId, mode: request.mode, title: request.title },
			},
			{ triggerTurn: false },
		);
		// While idle, pi appends the message synchronously. If it is in the session, the mailbox file is done.
		// Otherwise keep the file: a later scan finds the entry and removes it.
		const appended = this.deliveredIds().has(request.requestId);
		// Send the prompt before any await, so no user input can start a run in between.
		this.pi.sendUserMessage(request.prompt);
		this.ctx.ui.notify(`Merged side chat "${request.title}"`, "info");
		if (appended) await rm(path, { force: true }).catch(() => undefined);
	}
}
