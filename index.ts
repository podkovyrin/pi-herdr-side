import { rmdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { SideChatChild } from "./src/child.ts";
import { SIDE_CHAT_FLAG, SIDE_SESSIONS_DIR_NAME } from "./src/constants.ts";
import { Herdr, herdrEnvironmentProblem } from "./src/herdr.ts";
import { showMenu, startSideChat } from "./src/parent.ts";
import { MergeReceiver } from "./src/receiver.ts";
import { detectSideChatDir, isInsideDir, parentDir, parentMarkerPath, removeOwnLiveMarker, writeLiveMarker } from "./src/store.ts";

export default function piHerdrSide(pi: ExtensionAPI): void {
	pi.registerFlag(SIDE_CHAT_FLAG, {
		type: "string",
		description: "Internal: run this pi process as a pi-herdr-side side chat stored in the given directory",
	});

	const herdr = new Herdr((command, args, options) => pi.exec(command, args, options));
	const root = () => join(getAgentDir(), SIDE_SESSIONS_DIR_NAME);
	const flaggedChatDir = () => {
		const value = pi.getFlag(SIDE_CHAT_FLAG);
		return typeof value === "string" && value.trim() ? resolve(value) : undefined;
	};

	let child: SideChatChild | undefined;
	let receiver: MergeReceiver | undefined;
	/** The main session's side-chat directory. Removed on shutdown if it stayed empty. */
	let mainSessionDir: string | undefined;
	let markerPath: string | undefined;

	pi.on("session_start", async (_event, ctx) => {
		const sessionFile = ctx.sessionManager.getSessionFile();
		// The flag wins. Without it, a side-chat session file still makes this a side chat:
		// Herdr restores panes and users resume files as plain `pi --session <file>`.
		const flagged = flaggedChatDir();
		const dir = flagged ?? (await detectSideChatDir(sessionFile, root()));
		if (dir) {
			child = new SideChatChild(pi, dir, herdr, { detectedByPath: !flagged });
			await child.onSessionStart(ctx);
			return;
		}
		if (ctx.mode !== "tui" || herdrEnvironmentProblem()) return;
		// A side-chat file without valid metadata still carries the main session ID. Never receive merges for it.
		if (sessionFile && isInsideDir(sessionFile, root())) return;
		let sessionDir: string;
		try {
			sessionDir = parentDir(root(), ctx.sessionManager.getSessionId());
		} catch {
			return;
		}
		receiver = new MergeReceiver(pi, sessionDir, ctx);
		mainSessionDir = sessionDir;
		await receiver.start().catch(() => undefined);
		// The marker tells side chats that this session is running and which pane to focus after a merge.
		const paneId = await herdr.currentPaneId().catch(() => process.env.HERDR_PANE_ID);
		if (paneId) {
			markerPath = parentMarkerPath(sessionDir);
			await writeLiveMarker(markerPath, paneId).catch(() => undefined);
		}
	});

	pi.on("session_shutdown", async () => {
		receiver?.stop();
		receiver = undefined;
		if (markerPath) await removeOwnLiveMarker(markerPath).catch(() => undefined);
		markerPath = undefined;
		// Sessions that never used /side leave no directory behind. rmdir fails on a non-empty directory.
		if (mainSessionDir) await rmdir(mainSessionDir).catch(() => undefined);
		mainSessionDir = undefined;
		await child?.onSessionShutdown();
		child = undefined;
	});

	pi.on("agent_start", () => {
		child?.onAgentStart();
	});

	// Deliver merges that waited for the main agent. Leave the handler first: agent_settled is notification-only.
	pi.on("agent_settled", () => {
		child?.onAgentSettled();
		receiver?.schedule(0);
	});
	pi.on("session_compact", () => receiver?.schedule(0));
	pi.on("ui_prompt_start", () => receiver?.onUIPromptStart());
	pi.on("ui_prompt_end", () => receiver?.onUIPromptEnd());

	pi.on("input", (event, ctx) => {
		child?.onInput(event.text, event.source, ctx);
	});

	pi.registerCommand("side", {
		description: "[question] — Open a side chat in a new Herdr pane. In a side chat: merge it back into the main session",
		handler: async (args, ctx) => {
			if (child) {
				await child.merge(args, ctx);
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/side requires pi's interactive mode", "error");
				return;
			}
			const problem = herdrEnvironmentProblem();
			if (problem) {
				ctx.ui.notify(problem, "error");
				return;
			}
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (sessionFile && isInsideDir(sessionFile, root())) {
				ctx.ui.notify("/side is unavailable: this session file is in a side-chat directory without valid metadata", "error");
				return;
			}
			let sessionDir: string;
			try {
				sessionDir = parentDir(root(), ctx.sessionManager.getSessionId());
			} catch (error) {
				ctx.ui.notify(`/side failed: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}
			const question = args.trim();
			if (question) await startSideChat(pi, ctx, herdr, sessionDir, { question });
			else await showMenu(pi, ctx, herdr, sessionDir);
		},
	});
}
