import net from "node:net";
import { chooseDirection, shellQuote } from "./launch.ts";

export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

export type Exec = (command: string, args: string[], options?: { timeout?: number }) => Promise<ExecResult>;

export interface PaneRect {
	width: number;
	height: number;
}

export class HerdrError extends Error {
	override name = "HerdrError";
	readonly code: string | undefined;
	constructor(message: string, code?: string) {
		super(message);
		this.code = code;
	}
}

/**
 * What /side needs from the program that shows its panes. IDs are opaque:
 * pane IDs in the Herdr TUI, terminal IDs in the Herdr app.
 */
export interface HerdrHost {
	/** The ID of the pane or terminal this pi runs in. */
	currentId(): Promise<string>;
	/** Open a pane beside `mainId` that runs `sh launchPath` in `cwd`, focus it, and return its ID. */
	openBeside(mainId: string, cwd: string, launchPath: string): Promise<string>;
	exists(id: string): Promise<boolean>;
	focus(id: string): Promise<void>;
}

export function herdrEnvironmentProblem(env: NodeJS.ProcessEnv = process.env): string | undefined {
	if (env.HERDR_ENV === "1" && env.HERDR_PANE_ID) {
		return env.HERDR_SOCKET_PATH ? undefined : "/side needs HERDR_SOCKET_PATH, which Herdr sets in its panes";
	}
	if (env.HC_TERMINAL_ID) return undefined;
	return "/side must run inside a Herdr pane or a Herdr app terminal";
}

/**
 * The Herdr TUI wins when both are set: it can run inside a Herdr app
 * terminal, and then its panes are the ones around this pi.
 */
export function createHerdrHost(exec: Exec, env: NodeJS.ProcessEnv = process.env): HerdrHost {
	return env.HERDR_ENV === "1" && env.HERDR_PANE_ID ? new Herdr(exec, env) : new HerdrApp(exec, env);
}

/** Herdr prints `{"id":…,"error":{"code":…,"message":…}}` on stderr when a request fails. */
export function parseHerdrFailure(result: ExecResult): HerdrError {
	const raw = result.stderr.trim() || result.stdout.trim() || `herdr exited with code ${result.code}`;
	try {
		const parsed = JSON.parse(raw) as { error?: { code?: unknown; message?: unknown } };
		const message = parsed.error?.message;
		const code = parsed.error?.code;
		if (typeof message === "string") return new HerdrError(message, typeof code === "string" ? code : undefined);
	} catch {
		// Not JSON. Use the raw text.
	}
	return new HerdrError(raw.slice(0, 500));
}

export function parseResult(stdout: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		throw new HerdrError("herdr returned invalid JSON");
	}
	const result = (parsed as { result?: unknown }).result;
	if (!result || typeof result !== "object") throw new HerdrError("herdr returned no result");
	return result as Record<string, unknown>;
}

function paneIdOf(value: unknown): string {
	const id = (value as { pane_id?: unknown } | undefined)?.pane_id;
	if (typeof id !== "string" || id.length === 0 || id.startsWith("-")) {
		throw new HerdrError("herdr returned no valid pane_id");
	}
	return id;
}

/** True when the shell is the only foreground process, so typed input reaches its prompt. */
export function isShellReady(result: Record<string, unknown>): boolean {
	const info = result.process_info as
		| { shell_pid?: unknown; foreground_processes?: Array<{ pid?: unknown }> }
		| undefined;
	if (!info || typeof info.shell_pid !== "number" || !Array.isArray(info.foreground_processes)) return false;
	return info.foreground_processes.length > 0 && info.foreground_processes.every((p) => p.pid === info.shell_pid);
}

export class Herdr implements HerdrHost {
	private readonly exec: Exec;
	private readonly env: NodeJS.ProcessEnv;

	constructor(exec: Exec, env: NodeJS.ProcessEnv = process.env) {
		this.exec = exec;
		this.env = env;
	}

	private get binary(): string {
		return this.env.HERDR_BIN_PATH || "herdr";
	}

	private async paneRaw(args: string[], timeout = 10_000): Promise<string> {
		const result = await this.exec(this.binary, ["pane", ...args], { timeout });
		if (result.killed) throw new HerdrError(`herdr pane ${args[0]} timed out`);
		if (result.code !== 0) throw parseHerdrFailure(result);
		return result.stdout;
	}

	private async pane(args: string[], timeout = 10_000): Promise<Record<string, unknown>> {
		return parseResult(await this.paneRaw(args, timeout));
	}

	/** Resolve the caller's pane. HERDR_PANE_ID can be stale after a pane moves between workspaces. */
	async currentId(): Promise<string> {
		return paneIdOf((await this.pane(["current", "--current"])).pane);
	}

	/** Split the main pane, wait for its shell, and replace the shell with the launch script. */
	async openBeside(mainId: string, cwd: string, launchPath: string): Promise<string> {
		const direction = chooseDirection(await this.paneRect(mainId));
		const paneId = await this.split(mainId, direction, cwd);
		try {
			await this.waitForShell(paneId);
			await this.run(paneId, `exec sh ${shellQuote(launchPath)}`);
		} catch (error) {
			await this.close(paneId).catch(() => undefined);
			throw error;
		}
		return paneId;
	}

	async paneRect(paneId: string): Promise<PaneRect> {
		const layout = (await this.pane(["layout", "--pane", paneId])).layout as
			| { panes?: Array<{ pane_id?: unknown; rect?: { width?: unknown; height?: unknown } }> }
			| undefined;
		const rect = layout?.panes?.find((pane) => pane.pane_id === paneId)?.rect;
		if (typeof rect?.width !== "number" || typeof rect.height !== "number" || rect.width <= 0 || rect.height <= 0) {
			throw new HerdrError("herdr returned no valid size for the main pane");
		}
		return { width: rect.width, height: rect.height };
	}

	async split(paneId: string, direction: "right" | "down", cwd: string): Promise<string> {
		const result = await this.pane(["split", "--pane", paneId, "--direction", direction, "--cwd", cwd, "--focus"]);
		return paneIdOf(result.pane);
	}

	/** Wait until the new pane's shell owns the foreground. Typeahead also works, so a timeout is not fatal. */
	async waitForShell(paneId: string, timeoutMs = 5_000, intervalMs = 100): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			try {
				if (isShellReady(await this.pane(["process-info", "--pane", paneId], 2_000))) return true;
			} catch (error) {
				if (error instanceof HerdrError && error.code === "pane_not_found") throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, intervalMs));
		}
		return false;
	}

	/** Submit a command line to the pane. Do not retry: the text may already be delivered. */
	async run(paneId: string, command: string): Promise<void> {
		// Prints nothing on success.
		await this.paneRaw(["run", paneId, command]);
	}

	async close(paneId: string): Promise<void> {
		await this.pane(["close", paneId]);
	}

	async exists(paneId: string): Promise<boolean> {
		try {
			await this.pane(["get", paneId], 5_000);
			return true;
		} catch (error) {
			if (error instanceof HerdrError && error.code === "pane_not_found") return false;
			throw error;
		}
	}

	/** `herdr pane focus` only moves to a neighbor, so use the socket method that targets a pane ID. */
	focus(paneId: string, timeoutMs = 2_000): Promise<void> {
		const socketPath = this.env.HERDR_SOCKET_PATH;
		if (!socketPath) return Promise.reject(new HerdrError("HERDR_SOCKET_PATH is not set"));
		const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;
		return new Promise((resolve, reject) => {
			let buffer = "";
			let settled = false;
			const socket = net.createConnection(endpoint);
			const finish = (error?: Error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				socket.destroy();
				if (error) reject(error);
				else resolve();
			};
			const timer = setTimeout(() => finish(new HerdrError("herdr focus request timed out")), timeoutMs);
			socket.on("error", (error) => finish(error));
			socket.on("connect", () => {
				socket.write(`${JSON.stringify({ id: `pi-herdr-side:focus:${Date.now()}`, method: "pane.focus", params: { pane_id: paneId } })}\n`);
			});
			socket.on("data", (chunk) => {
				buffer += String(chunk);
				const newline = buffer.indexOf("\n");
				const line = newline === -1 ? buffer : buffer.slice(0, newline);
				try {
					const response = JSON.parse(line) as { error?: { message?: string; code?: string } };
					finish(response.error ? new HerdrError(response.error.message ?? "focus failed", response.error.code) : undefined);
				} catch {
					if (newline !== -1) finish(new HerdrError("herdr returned invalid JSON for focus"));
				}
			});
			socket.on("end", () => finish(new HerdrError("herdr closed the socket before replying")));
		});
	}
}

/**
 * The Herdr app: `herdr-app` arranges the window, `hc` (herdr-core) owns the
 * terminals. IDs are terminal IDs such as `t3`, which stay the same when a
 * pane moves; pane IDs do not.
 */
export class HerdrApp implements HerdrHost {
	private readonly exec: Exec;
	private readonly env: NodeJS.ProcessEnv;

	constructor(exec: Exec, env: NodeJS.ProcessEnv = process.env) {
		this.exec = exec;
		this.env = env;
	}

	private async json(binary: string, args: string[], timeout = 10_000): Promise<Record<string, unknown>> {
		const result = await this.exec(binary, args, { timeout });
		if (result.killed) throw new HerdrError(`${binary} ${args[0]} timed out`);
		let parsed: unknown;
		try {
			parsed = JSON.parse(result.stdout || result.stderr);
		} catch {
			throw new HerdrError((result.stderr.trim() || result.stdout.trim() || `${binary} exited with code ${result.code}`).slice(0, 500));
		}
		// herdr-app: {"error": "..."}; hc: {"error": {"kind", "message"}}.
		const error = (parsed as { error?: unknown }).error;
		if (typeof error === "string") throw new HerdrError(error);
		if (error && typeof error === "object") {
			const { kind, message } = error as { kind?: unknown; message?: unknown };
			throw new HerdrError(typeof message === "string" ? message : JSON.stringify(error), typeof kind === "string" ? kind : undefined);
		}
		if (result.code !== 0) throw new HerdrError(`${binary} exited with code ${result.code}`);
		if (!parsed || typeof parsed !== "object") throw new HerdrError(`${binary} returned no result`);
		return parsed as Record<string, unknown>;
	}

	private app(command: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
		return this.json("herdr-app", ["do", command, JSON.stringify(args)]);
	}

	private terminal(id: string, timeout?: number): Promise<Record<string, unknown>> {
		return this.json("hc", ["get", id, "--json"], timeout);
	}

	async currentId(): Promise<string> {
		const id = this.env.HC_TERMINAL_ID;
		if (!id) throw new HerdrError("HC_TERMINAL_ID is not set");
		return id;
	}

	private async paneOf(terminalId: string): Promise<string> {
		type Listing = { spaces?: Array<{ tabs?: Array<{ terminals?: Array<{ terminal?: unknown; pane?: unknown }> }> }> };
		const listing = (await this.json("herdr-app", ["ls"])) as Listing;
		for (const space of listing.spaces ?? []) {
			for (const tab of space.tabs ?? []) {
				const pane = tab.terminals?.find((entry) => entry.terminal === terminalId)?.pane;
				if (typeof pane === "string" && pane.length > 0) return pane;
			}
		}
		throw new HerdrError(`the Herdr window shows no pane for terminal ${terminalId}`);
	}

	async openBeside(mainId: string, cwd: string, launchPath: string): Promise<string> {
		const main = await this.terminal(mainId);
		const { cols, rows } = main as { cols?: unknown; rows?: unknown };
		if (typeof cols !== "number" || typeof rows !== "number" || cols <= 0 || rows <= 0) {
			throw new HerdrError("hc returned no valid size for the main terminal");
		}
		// The app runs argv directly, not through a shell, so change to the folder here.
		const argv = ["/bin/sh", "-c", 'cd "$1" && exec sh "$2"', "sh", cwd, launchPath];
		const created = await this.app("pane.split", {
			direction: chooseDirection({ width: cols, height: rows }),
			pane: await this.paneOf(mainId),
			argv,
		});
		const terminal = created.terminal;
		if (typeof terminal !== "string" || terminal.length === 0) throw new HerdrError("herdr-app returned no terminal ID");
		return terminal;
	}

	async exists(id: string): Promise<boolean> {
		try {
			return (await this.terminal(id, 5_000)).state === "live";
		} catch (error) {
			if (error instanceof HerdrError && error.code === "not_found") return false;
			throw error;
		}
	}

	async focus(id: string): Promise<void> {
		await this.app("pane.focus", { terminal: id });
	}
}
