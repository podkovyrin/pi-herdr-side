import { SIDE_CHAT_FLAG } from "./constants.ts";

export type SplitDirection = "right" | "down";

/** Terminal cells are about twice as tall as wide, so compare width with 2 × height. */
export function chooseDirection(rect: { width: number; height: number }): SplitDirection {
	return rect.width >= 2 * rect.height ? "right" : "down";
}

export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface NewChatArgs {
	kind: "new";
	sessionFile: string;
	chatDir: string;
	provider: string;
	modelId: string;
	thinkingLevel: string;
	/** Exact active tool names of the main session. Same set means same cached prefix. */
	tools: readonly string[];
	question?: string;
}

export interface ResumeChatArgs {
	kind: "resume";
	sessionFile: string;
	chatDir: string;
}

/**
 * pi reads a leading `@` as a file reference. A leading space keeps the
 * question as plain text without changing what the model sees in practice.
 */
export function protectInitialMessage(question: string): string {
	return question.startsWith("@") ? ` ${question}` : question;
}

export function buildPiArgs(options: NewChatArgs | ResumeChatArgs): string[] {
	const args = ["--session", options.sessionFile, "--session-dir", options.chatDir, `--${SIDE_CHAT_FLAG}`, options.chatDir];
	if (options.kind === "resume") return args;
	args.push("--provider", options.provider, "--model", options.modelId, "--thinking", options.thinkingLevel);
	if (options.tools.length > 0) args.push("--tools", options.tools.join(","));
	else args.push("--no-tools");
	const question = options.question?.trim();
	if (question) args.push("--", protectInitialMessage(question));
	return args;
}

/**
 * `exec` replaces the shell with pi, so the pane closes when pi exits. The
 * script keeps long or quoted arguments out of the interactive shell line.
 */
export function buildLaunchScript(piArgs: readonly string[], piCommand = "pi"): string {
	return `#!/bin/sh\nexec ${shellQuote(piCommand)} ${piArgs.map(shellQuote).join(" ")}\n`;
}
