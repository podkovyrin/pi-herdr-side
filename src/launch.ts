import { statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
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
	/** Active tool names of the main session. Same set means same cached prefix. */
	tools: readonly string[];
	question?: string;
}

export interface ResumeChatArgs {
	kind: "resume";
	sessionFile: string;
	chatDir: string;
	/**
	 * The side chat's tool list from meta.json, already without MCP tools.
	 * pi does not restore tools from the session file. Older chats have none,
	 * and then pi starts with its default tools.
	 */
	tools?: readonly string[];
}

/**
 * pi reads a leading `@` as a file reference. A leading space keeps the
 * question as plain text without changing what the model sees in practice.
 */
export function protectInitialMessage(question: string): string {
	return question.startsWith("@") ? ` ${question}` : question;
}

/**
 * The `--tools` list for the side chat. pi does not restore the active tools
 * from the session file when it opens one, so the list is needed. An entry
 * that starts with `mcp__` makes pi filter MCP tools by the list, which drops
 * MCP tools that only codemode or tool_search reach and changes the codemode
 * description. So MCP tools stay out, unless they are the only active tools.
 */
export function sideChatTools(tools: readonly string[]): string[] {
	const withoutMcp = tools.filter((name) => !name.startsWith("mcp__"));
	return withoutMcp.length > 0 ? withoutMcp : [...tools];
}

const toolArgs = (tools: readonly string[]) => (tools.length > 0 ? ["--tools", tools.join(",")] : ["--no-tools"]);

export function buildPiArgs(options: NewChatArgs | ResumeChatArgs): string[] {
	const args = ["--session", options.sessionFile, "--session-dir", options.chatDir, `--${SIDE_CHAT_FLAG}`, options.chatDir];
	if (options.kind === "resume") {
		// pi restores model and thinking level from the session file, but not the tools.
		if (options.tools) args.push(...toolArgs(options.tools));
		return args;
	}
	args.push("--provider", options.provider, "--model", options.modelId, "--thinking", options.thinkingLevel);
	args.push(...toolArgs(sideChatTools(options.tools)));
	const question = options.question?.trim();
	if (question) args.push("--", protectInitialMessage(question));
	return args;
}

const isFile = (path: string) => {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
};

/**
 * The command that runs this pi: the same runtime and entry script, so the
 * side chat runs the same pi version and sends the same system prompt. A
 * `pi` from the new pane's PATH can be another version. Node flags in
 * execArgv (inspector, debugging) are not passed on.
 */
export function currentPiCommand(
	execPath: string = process.execPath,
	script: string | undefined = process.argv[1],
	fileExists: (path: string) => boolean = isFile,
): string[] {
	return script && isAbsolute(script) && fileExists(script) ? [execPath, script] : ["pi"];
}

/** Set by pi for each bash tool call. In the side chat pi sets its own values. */
const PER_CALL_VARIABLES = new Set(["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"]);
const PROXY_VARIABLES = new Set(
	["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY"].flatMap((name) => [name, name.toLowerCase()]),
);

/**
 * Variables the side chat gets from the main pi process: pi's own `PI_*`
 * settings and proxies. Everything else comes from the new pane's shell.
 */
export function forwardedEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
	const forwarded: Record<string, string> = {};
	for (const [name, value] of Object.entries(env)) {
		if (value === undefined || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
		if ((name.startsWith("PI_") && !PER_CALL_VARIABLES.has(name)) || PROXY_VARIABLES.has(name)) forwarded[name] = value;
	}
	return forwarded;
}

/** Shell test that the pi command can run. */
function runnableTest(command: readonly string[]): string {
	const [binary = "pi", ...rest] = command;
	const tests = [
		binary.includes("/") ? `[ -x ${shellQuote(binary)} ]` : `command -v ${shellQuote(binary)} >/dev/null 2>&1`,
		...rest.filter((part) => isAbsolute(part)).map((part) => `[ -f ${shellQuote(part)} ]`),
	];
	return tests.join(" && ");
}

/**
 * The managed pi shim puts its Node directory on PATH before it starts pi, so
 * pi's bash tool and `pi update` find node and npm. Starting the runtime
 * directly skips the shim, so do the same for the [runtime, script] form.
 */
function pathSetup(command: readonly string[]): string {
	const [runtime] = command;
	if (command.length !== 2 || !runtime || !isAbsolute(runtime)) return "";
	const dir = shellQuote(dirname(runtime));
	return `case ":$PATH:" in\n\t*:${dir}:*) ;;\n\t*) PATH=${dir}\${PATH:+:\$PATH}; export PATH ;;\nesac\n`;
}

/**
 * `exec` replaces the shell with pi, so the pane closes when pi exits. The
 * script keeps long or quoted arguments out of the interactive shell line.
 * If pi cannot run, the script says so and waits, instead of closing the
 * pane at once.
 */
export function buildLaunchScript(
	piArgs: readonly string[],
	piCommand: readonly string[] = ["pi"],
	env: Readonly<Record<string, string>> = {},
): string {
	const exports = Object.entries(env)
		.filter(([name]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
		.map(([name, value]) => `export ${name}=${shellQuote(value)}\n`)
		.join("");
	const error = `pi-herdr-side: cannot start pi: ${piCommand.join(" ")}`;
	return [
		"#!/bin/sh\n",
		exports,
		pathSetup(piCommand),
		`if ! { ${runnableTest(piCommand)}; }; then\n`,
		`\tprintf '%s\\n' ${shellQuote(error)} >&2\n`,
		"\tprintf 'Press Enter to close this pane. ' >&2\n",
		"\tread -r _\n",
		"\texit 127\n",
		"fi\n",
		`exec ${[...piCommand, ...piArgs].map(shellQuote).join(" ")}\n`,
	].join("");
}
