import { existsSync, watch, type FSWatcher } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
	CURRENT_SESSION_VERSION,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	TreeSelectorComponent,
} from "@earendil-works/pi-coding-agent";
import { type Component, type Focusable, Key, matchesKey } from "@earendil-works/pi-tui";
import { LAUNCH_FILE, MERGE_CUSTOM_TYPE, SIDE_NOTE } from "./constants.ts";
import { buildForkSession, type EntryLike } from "./fork.ts";
import { Herdr } from "./herdr.ts";
import { buildLaunchScript, buildPiArgs, chooseDirection, shellQuote, type NewChatArgs, type ResumeChatArgs } from "./launch.ts";
import { buildMergeMessage, deliveredRequestIds, findPendingMerges, mergeDetailsOf, type PendingMerge } from "./merge.ts";
import {
	type ChatMeta,
	type ChatSummary,
	chatPaths,
	ensurePrivateDir,
	listChats,
	newChatId,
	writeFileAtomic,
	writeJson,
} from "./store.ts";
import { formatAge, toTitle } from "./text.ts";

function errorText(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

/** Split the main pane, wait for its shell, and replace the shell with pi. */
async function launchInPane(herdr: Herdr, cwd: string, chatDir: string, args: NewChatArgs | ResumeChatArgs): Promise<string> {
	const launchPath = join(chatDir, LAUNCH_FILE);
	await writeFileAtomic(launchPath, buildLaunchScript(buildPiArgs(args)), 0o700);
	const mainPane = await herdr.currentPaneId();
	const direction = chooseDirection(await herdr.paneRect(mainPane));
	const paneId = await herdr.split(mainPane, direction, cwd);
	try {
		await herdr.waitForShell(paneId);
		await herdr.run(paneId, `exec sh ${shellQuote(launchPath)}`);
	} catch (error) {
		await herdr.close(paneId).catch(() => undefined);
		throw error;
	}
	return paneId;
}

export interface StartOptions {
	question?: string;
	/** Fork the branch that ends at this entry instead of the current leaf. */
	entryId?: string;
}

export async function startSideChat(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	herdr: Herdr,
	dir: string,
	options: StartOptions,
): Promise<void> {
	const model = ctx.model;
	if (!model) {
		ctx.ui.notify("/side needs an active model", "error");
		return;
	}
	const chatId = newChatId();
	const chatDir = join(dir, chatId);
	const question = options.question?.trim();
	try {
		await ensurePrivateDir(chatDir);
		const now = new Date();
		// pi writes the session file only after the first message. Do not point at a file that does not exist.
		const mainFile = ctx.sessionManager.getSessionFile();
		const parentSessionFile = mainFile && existsSync(mainFile) ? mainFile : null;
		const branch = ctx.sessionManager.getBranch(options.entryId) as unknown as EntryLike[];
		const fork = buildForkSession({
			sessionId: ctx.sessionManager.getSessionId(),
			sessionVersion: CURRENT_SESSION_VERSION,
			cwd: ctx.cwd,
			...(parentSessionFile ? { parentSessionFile } : {}),
			branch,
			note: SIDE_NOTE,
			...(question ? { name: toTitle(question) } : {}),
			now,
		});
		const sessionFile = join(chatDir, fork.fileName);
		await writeFileAtomic(sessionFile, fork.content);
		const meta: ChatMeta = {
			version: 1,
			chatId,
			parentSessionId: ctx.sessionManager.getSessionId(),
			parentSessionFile,
			cwd: ctx.cwd,
			createdAt: now.toISOString(),
			sessionFileName: fork.fileName,
			noteEntryId: fork.noteEntryId,
		};
		await writeJson(chatPaths(chatDir).meta, meta);
		await launchInPane(herdr, ctx.cwd, chatDir, {
			kind: "new",
			sessionFile,
			chatDir,
			provider: model.provider,
			modelId: model.id,
			thinkingLevel: pi.getThinkingLevel(),
			tools: pi.getActiveTools(),
			...(question ? { question } : {}),
		});
	} catch (error) {
		await rm(chatDir, { recursive: true, force: true }).catch(() => undefined);
		ctx.ui.notify(`/side failed: ${errorText(error)}`, "error");
	}
}

async function resumeSideChat(ctx: ExtensionCommandContext, herdr: Herdr, chat: ChatSummary): Promise<void> {
	try {
		if (chat.openPaneId && (await herdr.paneExists(chat.openPaneId))) {
			await herdr.focus(chat.openPaneId);
			return;
		}
		await launchInPane(herdr, chat.meta.cwd || ctx.cwd, chat.dir, { kind: "resume", sessionFile: chat.sessionFile, chatDir: chat.dir });
	} catch (error) {
		ctx.ui.notify(`/side failed: ${errorText(error)}`, "error");
	}
}

/** Wraps pi's tree selector so Ctrl+C closes it like Escape. */
class TreePicker implements Component, Focusable {
	private readonly selector: TreeSelectorComponent;
	private readonly onClose: () => void;

	constructor(selector: TreeSelectorComponent, onClose: () => void) {
		this.selector = selector;
		this.onClose = onClose;
	}
	get focused(): boolean {
		return this.selector.focused;
	}
	set focused(value: boolean) {
		this.selector.focused = value;
	}
	render(width: number): string[] {
		return this.selector.render(width);
	}
	handleInput(data: string): void {
		if (matchesKey(data, Key.ctrl("c"))) this.onClose();
		else this.selector.handleInput(data);
	}
	invalidate(): void {
		this.selector.invalidate();
	}
}

async function pickEntry(ctx: ExtensionCommandContext): Promise<string | undefined> {
	const tree = ctx.sessionManager.getTree();
	if (tree.length === 0) {
		ctx.ui.notify("The main session has no entries yet", "warning");
		return undefined;
	}
	const leafId = ctx.sessionManager.getLeafId();
	return ctx.ui.custom<string | undefined>((tui, _theme, _keybindings, done) => {
		const selector = new TreeSelectorComponent(
			tree,
			leafId,
			tui.terminal.rows,
			(entryId) => done(entryId),
			() => done(undefined),
		);
		return new TreePicker(selector, () => done(undefined));
	});
}

const MENU_NEW = "New side chat";
const MENU_TREE = "Start from main thread tree…";
const MENU_RESUME = "Resume side chat…";

export async function showMenu(pi: ExtensionAPI, ctx: ExtensionCommandContext, herdr: Herdr, dir: string): Promise<void> {
	const chats = await listChats(dir).catch(() => []);
	const options = [MENU_NEW, MENU_TREE, ...(chats.length > 0 ? [MENU_RESUME] : [])];
	const choice = await ctx.ui.select("Side chat", options);
	if (choice === MENU_NEW) return startSideChat(pi, ctx, herdr, dir, {});
	if (choice === MENU_TREE) {
		const entryId = await pickEntry(ctx);
		if (entryId) await startSideChat(pi, ctx, herdr, dir, { entryId });
		return;
	}
	if (choice !== MENU_RESUME) return;
	const labels = chats.map((chat, index) => {
		const count = chat.questions === 1 ? "1 question" : `${chat.questions} questions`;
		const open = chat.openPaneId ? " · open" : "";
		return `${index + 1}. ${chat.title} · ${count} · ${formatAge(chat.updatedAt)}${open}`;
	});
	const picked = await ctx.ui.select("Resume side chat", labels);
	const chat = picked === undefined ? undefined : chats[labels.indexOf(picked)];
	if (chat) await resumeSideChat(ctx, herdr, chat);
}

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
	/** Request ID → mailbox file, removed once the merge message is in the session. */
	private readonly inFlight = new Map<string, string>();

	private readonly pi: ExtensionAPI;
	private readonly dir: string;
	private readonly ctx: ExtensionContext;

	constructor(pi: ExtensionAPI, dir: string, ctx: ExtensionContext) {
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

	/** Called for every finished message. Removes the mailbox file once the merge is persisted. */
	onMessageEnd(message: { role?: string; customType?: string; details?: unknown }): void {
		if (message.role !== "custom" || message.customType !== MERGE_CUSTOM_TYPE) return;
		const requestId = mergeDetailsOf(message.details)?.requestId;
		const path = requestId ? this.inFlight.get(requestId) : undefined;
		if (!requestId || !path) return;
		this.inFlight.delete(requestId);
		void rm(path, { force: true }).catch(() => undefined);
	}

	private async scan(): Promise<void> {
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
			const delivered = deliveredRequestIds(this.ctx.sessionManager.getEntries() as unknown as Array<Record<string, unknown>>);
			const next: PendingMerge[] = [];
			for (const merge of pending) {
				if (delivered.has(merge.request.requestId)) await rm(merge.path, { force: true }).catch(() => undefined);
				else if (!this.inFlight.has(merge.request.requestId)) next.push(merge);
			}
			// Never inject into a running turn or a compaction. agent_settled schedules the next scan.
			const first = next[0];
			if (!first || !this.ctx.isIdle()) return;
			this.deliver(first);
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

	private deliver({ path, request }: PendingMerge): void {
		this.inFlight.set(request.requestId, path);
		this.pi.sendMessage(
			{
				customType: MERGE_CUSTOM_TYPE,
				content: buildMergeMessage(request),
				display: true,
				details: { requestId: request.requestId, chatId: request.chatId, mode: request.mode, title: request.title },
			},
			{ triggerTurn: false },
		);
		this.pi.sendUserMessage(request.prompt);
		this.ctx.ui.notify(`Merged side chat "${request.title}"`, "info");
	}
}
