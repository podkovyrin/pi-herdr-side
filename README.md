# pi-herdr-side

A [Pi](https://pi.dev) extension that opens a side chat in a new [Herdr](https://herdr.dev) pane. The side chat is a fork of your current session. Ask a tangent question there, keep the main agent working, and merge the result back when you're done.

## What it does

- `/side <question>` forks the main session into a new pane and sends the question.
- The side chat has the full main context, the same model, thinking level, and tools, so the first request reuses the main session's prompt cache.
- Side chats are saved. You can resume them later, even after a restart.
- `/side` inside a side chat merges it back. The main session gets the side chat as a message, then runs your follow-up prompt.

## Requirements

- Pi 1.0.4 or later, in interactive mode.
- Pi must run inside a Herdr pane (`HERDR_ENV=1`). Herdr 0.9 is tested.

## Install

```bash
pi install npm:pi-herdr-side
```

From GitHub:

```bash
pi install git:github.com/podkovyrin/pi-herdr-side
```

From a checkout:

```bash
pi install /absolute/path/to/pi-herdr-side
```

## Usage

In the main session:

| Command | Result |
|---|---|
| `/side <question>` | Opens a side chat and sends the question. |
| `/side` | Opens a menu: new side chat, start from a main thread tree entry, or resume a side chat. |

In a side chat:

| Command | Result |
|---|---|
| `/side <prompt>` | Merges the side chat into the main session, then runs `<prompt>` there. |
| `/side` | Opens an editor for the prompt, then merges. |

There are no subcommands in the main session. `/side merge conflicts?` is a question.

The new pane splits from the main pane, to the right if the pane is wide (width at least twice the height) and down if it isn't. Focus moves to the new pane. The pane closes when you quit the side chat. If pi can't start in the new pane, the pane shows an error and waits for Enter.

The new pane runs the same pi as the main session: the same Node binary and pi script, not the `pi` on the new shell's `PATH`. The Node binary's directory goes first on `PATH` if it isn't on it yet, as pi's own launcher does. It gets the main pi's `PI_*` variables and proxy variables (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `ALL_PROXY`, in either case). All other variables come from the new pane's shell. An API key that you exported only in the shell of the main pi is not there.

Resume lists the side chats of the current main session, newest first. The title is the side chat's own name or its first question. A side chat that is already open gets focus instead of a second pane. Side chats that never ran a turn, aren't open, and are older than a minute are deleted when the menu opens.

A side-chat session file opened with plain `pi --session <file>`, for example when Herdr restores a pane, still runs as that side chat.

## Merge

Before it sends anything, the merge asks for a format:

- **Transcript.** The side-chat questions and answers as text. Tool calls, tool output, and thinking are left out. If the transcript is larger than 48 KiB, the oldest turns are dropped.
- **Summary.** The side chat runs one more turn that summarizes itself, and that summary is sent. If that turn doesn't start (for example, no model or no API key) or gives no text, nothing is merged. Summary turns are left out of later transcripts and of the Resume title and question count.

After the merge, focus goes back to the main pane and the side pane closes. If the main agent is busy, has queued messages, or shows a dialog, the merge waits, so it never lands in the middle of a run. If the main session isn't running, the side chat keeps the merge on disk and the main session receives it when you resume it.

A second merge from the same side chat sends only the turns after the first one.

## Prompt cache

The fork copies the main branch unchanged, including pi's recorded system prompt and tool state. It also reuses the main session ID, which pi sends as the cache key or affinity header to providers such as OpenRouter and OpenAI. The side-chat instructions are a hidden message after the history, not a system prompt change.

The result is that the first side-chat request has the same prefix as the last main request. In a test with a 62k-token main context on Claude Opus through OpenRouter, the first side-chat turn read 61,897 tokens from cache and wrote 120.

If you change the model or tools inside the side chat, the prefix changes and the cache no longer applies.

pi doesn't restore the active tools from a session file, so the side chat gets the main session's active tools through `--tools`. The list is saved with the side chat, and Resume passes it again. A side chat opened with plain `pi --session <file>` sets the saved list when it starts. Side chats created by older versions have no saved list and start with pi's default tools. MCP tools (`mcp__…`) are left out of that list: one `mcp__` entry makes pi filter MCP tools by the list, which removes the MCP tools that codemode reaches and changes the codemode description. The trade-off: MCP tools that the main session declares directly (`direct` exposure) are not declared in the side chat. Codemode can still call them, but the tool list differs and the first request misses the cache. If only MCP tools are active, they are passed as they are.

## Things to know

- The side chat sees the main session as it was when you forked it. It doesn't see later main-session activity.
- If you fork while the main agent is mid-turn, the copy can end in tool calls without results. pi fills those with "No result provided".
- The side chat uses the main session ID, not only as the cache key. In the side chat, `PI_SESSION_ID` in bash is the main session ID, and other extensions that key state by session ID share that state with the main session.
- The side chat has all the tools of the main session and shares its working directory. Its instructions tell the model not to modify files unless you ask, but the tools are not blocked.
- Side chats live in `~/.pi/agent/side-sessions/<main session ID>/`. Each one holds a full copy of the forked main branch, so large sessions take disk space. Delete the directories you no longer need.
- Side-chat sessions don't show up in pi's own `/resume`. Use `/side` → Resume.

## Development

```bash
npm install
npm run check
```

`npm run check` runs the TypeScript check and the unit tests (`node --test`).

## License

MIT
