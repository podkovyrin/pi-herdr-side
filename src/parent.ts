import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
	CURRENT_SESSION_VERSION,
	type ExtensionAPI,
	type ExtensionCommandContext,
	TreeSelectorComponent,
} from "@earendil-works/pi-coding-agent";
import { type Component, type Focusable, Key, matchesKey } from "@earendil-works/pi-tui";
import { LAUNCH_FILE, SIDE_NOTE } from "./constants.ts";
import { buildForkSession, type EntryLike } from "./fork.ts";
import { Herdr } from "./herdr.ts";
import {
	buildLaunchScript,
	buildPiArgs,
	chooseDirection,
	currentPiCommand,
	forwardedEnv,
	shellQuote,
	sideChatTools,
	type NewChatArgs,
	type ResumeChatArgs,
} from "./launch.ts";
import {
	type ChatMeta,
	type ChatSummary,
	chatPaths,
	ensurePrivateDir,
	isToolName,
	listChats,
	newChatId,
	writeFileAtomic,
	writeJson,
} from "./store.ts";
import { formatAge, toTitle } from "./text.ts";

function errorText(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

/**
 * Split the main pane, wait for its shell, and replace the shell with pi. The
 * script runs this pi with its PI_* and proxy variables; the side chat deletes
 * it at startup.
 */
async function launchInPane(herdr: Herdr, cwd: string, chatDir: string, args: NewChatArgs | ResumeChatArgs): Promise<string> {
	const launchPath = join(chatDir, LAUNCH_FILE);
	await writeFileAtomic(launchPath, buildLaunchScript(buildPiArgs(args), currentPiCommand(), forwardedEnv()), 0o700);
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
		const activeTools = pi.getActiveTools();
		const meta: ChatMeta = {
			version: 1,
			chatId,
			parentSessionId: ctx.sessionManager.getSessionId(),
			parentSessionFile,
			cwd: ctx.cwd,
			createdAt: now.toISOString(),
			sessionFileName: fork.fileName,
			noteEntryId: fork.noteEntryId,
			noteByteOffset: fork.noteByteOffset,
			// One invalid name would make the whole meta invalid, so keep only names it accepts.
			tools: sideChatTools(activeTools).filter(isToolName),
		};
		await writeJson(chatPaths(chatDir).meta, meta);
		await launchInPane(herdr, ctx.cwd, chatDir, {
			kind: "new",
			sessionFile,
			chatDir,
			provider: model.provider,
			modelId: model.id,
			thinkingLevel: pi.getThinkingLevel(),
			tools: activeTools,
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
		await launchInPane(herdr, chat.meta.cwd || ctx.cwd, chat.dir, {
			kind: "resume",
			sessionFile: chat.sessionFile,
			chatDir: chat.dir,
			...(chat.meta.tools ? { tools: chat.meta.tools } : {}),
		});
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

/** Chats that never ran a turn and are not open are leftovers once they are this old: pi failed to start, or the pane was closed at once. */
const EMPTY_CHAT_GRACE_MS = 60_000;

export async function showMenu(pi: ExtensionAPI, ctx: ExtensionCommandContext, herdr: Herdr, dir: string): Promise<void> {
	const chats = await listChats(dir, { pruneEmptyAfterMs: EMPTY_CHAT_GRACE_MS }).catch(() => []);
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
