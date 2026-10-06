import { rmdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { SideChatChild } from "./src/child.ts";
import { SIDE_CHAT_FLAG, SIDE_SESSIONS_DIR_NAME } from "./src/constants.ts";
import { Herdr, herdrEnvironmentProblem } from "./src/herdr.ts";
import { MergeReceiver, showMenu, startSideChat } from "./src/parent.ts";
import { parentDir, parentMarkerPath, removeOwnLiveMarker, writeLiveMarker } from "./src/store.ts";

export default function piHerdrSide(pi: ExtensionAPI): void {
	pi.registerFlag(SIDE_CHAT_FLAG, {
		type: "string",
		description: "Internal: run this pi process as a pi-herdr-side side chat stored in the given directory",
	});

	const herdr = new Herdr((command, args, options) => pi.exec(command, args, options));
	const root = () => join(getAgentDir(), SIDE_SESSIONS_DIR_NAME);
	const childDir = () => {
		const value = pi.getFlag(SIDE_CHAT_FLAG);
		return typeof value === "string" && value.trim() ? resolve(value) : undefined;
	};

	let child: SideChatChild | undefined;
	let receiver: MergeReceiver | undefined;
	let markerPath: string | undefined;

	pi.on("session_start", async (_event, ctx) => {
		const dir = childDir();
		if (dir) {
			child = new SideChatChild(pi, dir, herdr);
			await child.onSessionStart(ctx);
			return;
		}
		if (ctx.mode !== "tui" || herdrEnvironmentProblem()) return;
		let sessionDir: string;
		try {
			sessionDir = parentDir(root(), ctx.sessionManager.getSessionId());
		} catch {
			return;
		}
		receiver = new MergeReceiver(pi, sessionDir, ctx);
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
		if (markerPath) {
			await removeOwnLiveMarker(markerPath).catch(() => undefined);
			// Sessions that never used /side leave no directory behind. rmdir fails on a non-empty directory.
			await rmdir(dirname(markerPath)).catch(() => undefined);
		}
		markerPath = undefined;
		await child?.onSessionShutdown();
	});

	pi.on("message_end", (event) => {
		receiver?.onMessageEnd(event.message as { role?: string; customType?: string; details?: unknown });
	});

	// Deliver merges that waited for the main agent. Leave the handler first: agent_settled is notification-only.
	pi.on("agent_settled", () => {
		child?.onAgentSettled();
		receiver?.schedule(0);
	});
	pi.on("session_compact", () => receiver?.schedule(0));

	pi.on("input", (event) => {
		child?.onInput(event.text, event.source);
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
