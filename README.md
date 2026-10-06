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

The new pane splits from the main pane, to the right if the pane is wide (width at least twice the height) and down if it isn't. Focus moves to the new pane. The pane closes when you quit the side chat.

Resume lists the side chats of the current main session, newest first. A side chat that is already open gets focus instead of a second pane.

## Merge

Before it sends anything, the merge asks for a format:

- **Transcript.** The side-chat questions and answers as text. Tool calls, tool output, and thinking are left out. If the transcript is larger than 48 KiB, the oldest turns are dropped.
- **Summary.** The side chat runs one more turn that summarizes itself, and that summary is sent.

After the merge, focus goes back to the main pane and the side pane closes. If the main agent is busy, the merge waits until the agent settles, so it never lands in the middle of a run. If the main session isn't running, the side chat keeps the merge on disk and the main session receives it when you resume it.

A second merge from the same side chat sends only the turns after the first one.

## Prompt cache

The fork copies the main branch unchanged, including pi's recorded system prompt and tool state. It also reuses the main session ID, which pi sends as the cache key or affinity header to providers such as OpenRouter and OpenAI. The side-chat instructions are a hidden message after the history, not a system prompt change.

The result is that the first side-chat request has the same prefix as the last main request. In a test with a 62k-token main context on Claude Opus through OpenRouter, the first side-chat turn read 61,897 tokens from cache and wrote 120.

If you change the model or tools inside the side chat, the prefix changes and the cache no longer applies.

## Things to know

- The side chat sees the main session as it was when you forked it. It doesn't see later main-session activity.
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
