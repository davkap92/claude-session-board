# Claude session board

A kanban board for your Claude Code desktop sessions. Each repo gets a swimlane
and each session is a card, sorted into columns by what it is waiting on: you,
CI, a reviewer, or nothing. Click a card to read the conversation and reply to
it without switching to the desktop app.

It runs locally, has no dependencies beyond Node, and reads the files the
desktop app already writes. Nothing leaves your machine except `gh` calls for
PR status.

## What you get

- One swimlane per repo. Sessions in worktrees are grouped with their
  parent repo.
- The app's end-of-turn summary, the session's
  transcript and the PR's checks and review decision decide where a card sits
  (see [Columns](#columns)).
- A pulsing dot marks a session Claude is working in right now.
  Cards show the last summary, a "waiting on you" callout when there is one,
  badges such as `CI failing` or `changes requested`, and the PR number.
- Click a card to read the transcript, with tool calls folded
  away, and send a reply. "Open in Claude" jumps to the session in the desktop
  app.
- Filters: search (`/`), a 24h / 7d / 14d / All window, hide a column by
  clicking its total, collapse a lane by clicking its name. `r` refreshes; the
  board also refreshes every 15 seconds.

## Requirements

- macOS with the Claude desktop app, and sessions in its Code tab
- Node 20 or later
- [`gh`](https://cli.github.com/) signed in, for PR checks and review state
- The `claude` CLI signed in (`claude auth login`), only if you want to reply
  from the board

## Run it

```bash
git clone https://github.com/davkap92/claude-session-board.git
cd claude-session-board
npm start
```

Open http://127.0.0.1:4777.

### Start on login

```bash
scripts/install-launchd.sh
```

This writes a launchd agent to
`~/Library/LaunchAgents/com.local.claude-session-board.plist` that starts the
board at login and restarts it if it exits. It pins the Node binary you have
on `PATH` when you run it, so rerun the script after removing that Node
version. Logs go to `~/Library/Logs/claude-session-board.log`.

```bash
# restart after pulling changes
launchctl kickstart -k gui/$(id -u)/com.local.claude-session-board
```

```bash
# stop and remove from login
scripts/install-launchd.sh uninstall
```

While the agent runs, `npm start` fails because the port is taken. Set `PORT`
to run a second copy.

## Columns

| Column | A session lands here when |
| --- | --- |
| Working | Claude is mid-turn |
| Needs you | The app's summary says it is blocked or waiting on you, a reviewer requested changes, or it finished with no PR and the app marked the result ready for your review |
| CI | It has an open PR with failing or running checks |
| In review | It has an open PR, checks are green, and it is not approved yet |
| Ready to merge | It has an open PR that is approved and green |
| Done | Its PR merged or closed, or it finished with nothing pending |

Working, CI, In review and Ready to merge always show. Needs you and Done
follow the time window.

A PR attached to three or more sessions that didn't open it (usually the
branch the main checkout sits on) is shown dimmed and not used for placement.

## Replying from the board

A reply runs `claude -p --resume <session>` in the session's folder with the
session's permission mode. The turn lands in the same transcript the desktop
app reads, so it shows up there too.

- Replies are refused while Claude is working in that session in the desktop
  app, so two processes never write one transcript at once.
- The headless turn uses your CLI settings and MCP servers, not the desktop's
  per-session connectors.
- The CLI's sign-in is separate from the desktop app's. If a reply fails with
  an auth error, run `claude auth login`.

## How it works

`server.mjs` is a single zero-dependency Node server bound to `127.0.0.1`.
`public/index.html` is the whole front end, in plain JavaScript.

| Data | Source |
| --- | --- |
| Sessions, titles, PRs, end-of-turn summaries | The desktop app's session files in `~/Library/Application Support/Claude/claude-code-sessions/`, read-only |
| Whether Claude is mid-turn, last activity, chat | The session's transcript in `~/.claude/projects/`. A turn is open when the last message isn't a finished assistant reply, capped at 30 minutes |
| CI and review state | `gh pr view` for each open PR, cached for 60 seconds |

Only the board's own page can send replies: the server rejects requests whose
`Host` or `Origin` isn't the board's local address, and accepts JSON only.

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4777` | Port to listen on |
| `CLAUDE_SESSIONS_DIR` | the desktop app's sessions folder | Read sessions from somewhere else |
| `CLAUDE_BIN` | `claude` | CLI used for replies |

## Caveats

The desktop app's session files are not a public format. A desktop update can
change them and break the board.
