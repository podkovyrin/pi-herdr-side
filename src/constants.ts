/** CLI flag that marks a pi process as a side chat. Its value is the side chat directory. */
export const SIDE_CHAT_FLAG = "side-chat";

/** Custom message types written into sessions by this extension. */
export const NOTE_CUSTOM_TYPE = "pi-herdr-side.note";
export const MERGE_CUSTOM_TYPE = "pi-herdr-side.merge";
/** Non-context entry in the side chat that marks what was already merged. */
export const MERGED_MARKER_TYPE = "pi-herdr-side.merged";

/** Directory under the pi agent directory that holds all side chats. */
export const SIDE_SESSIONS_DIR_NAME = "side-sessions";

export const META_FILE = "meta.json";
export const PANE_FILE = "pane.json";
export const PARENT_FILE = "parent.json";
export const LAUNCH_FILE = "launch.sh";
export const MERGE_FILE_PREFIX = "merge-";

/** Upper bound for merged content, so one merge cannot flood the main context. */
export const MERGE_CONTENT_BUDGET_BYTES = 48 * 1024;
export const MAX_PROMPT_BYTES = 16 * 1024;
export const MAX_TITLE_CHARS = 72;

/**
 * Hidden note appended after the forked history. It is a message, not a system
 * prompt change, so the cached prefix (tools, system prompt, history) stays
 * identical to the main session.
 */
export const SIDE_NOTE = `[pi-herdr-side] You are now in a side chat forked from the main session at this point. The main agent continues separately and does not see this conversation unless the user merges it back with /side. Answer the user's side questions directly and concisely. Do not modify files unless the user explicitly asks you to.`;

export function summaryPrompt(sinceLastMerge: boolean): string {
	const scope = sinceLastMerge
		? "this side chat since its last merge into the main session"
		: "this side chat";
	return `Summarize ${scope} for the main session. Include the conclusions, decisions, facts you verified, and open questions. Leave out the forked main-session context that came before the side chat. Write only the summary.`;
}

/** Summary turns are merge plumbing, not side-chat content. Transcripts, titles, and counts skip them. */
export function isSummaryPrompt(text: string): boolean {
	const trimmed = text.trim();
	return trimmed === summaryPrompt(true) || trimmed === summaryPrompt(false);
}
