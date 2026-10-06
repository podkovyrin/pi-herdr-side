import net from "node:net";

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

export function herdrEnvironmentProblem(env: NodeJS.ProcessEnv = process.env): string | undefined {
	if (env.HERDR_ENV !== "1" || !env.HERDR_PANE_ID) return "/side must run inside a Herdr pane";
	if (!env.HERDR_SOCKET_PATH) return "/side needs HERDR_SOCKET_PATH, which Herdr sets in its panes";
	return undefined;
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

export class Herdr {
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
	async currentPaneId(): Promise<string> {
		return paneIdOf((await this.pane(["current", "--current"])).pane);
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

	async paneExists(paneId: string): Promise<boolean> {
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
