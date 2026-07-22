# google-tasks-mcp

An [MCP](https://modelcontextprotocol.io) server for **Google Tasks** with the full API surface: task-list CRUD, task CRUD, move/reorder, and a purpose-built `diff_tasks` tool for harvesting what changed since your agent last looked.

Built for agents that maintain a task mirror (project lists your assistant keeps in sync, completions you tick on your phone that the agent picks up later), but works as a general Tasks connector.

## Why another one

The existing community servers all fail at least one of these:

| Capability | This server |
|---|---|
| Create / rename / delete task **lists** (per-project lists) | ✅ |
| Harvest completions made in the Google Tasks apps (they become `hidden`!) | ✅ `diff_tasks` |
| Move / reorder / re-parent, including across lists | ✅ `move_task` |
| Runs via `npx`, no clone-and-build | ✅ |
| Sane auth (one command, refresh token cached, no weekly re-login) | ✅ |

## Install

```bash
# 1. One-time auth (see Google Cloud setup below first)
npx google-tasks-mcp auth

# 2. Register with your MCP client, e.g. Claude Code:
claude mcp add -s user gtasks -- npx google-tasks-mcp
```

Any MCP-capable client works; the server speaks stdio.

## Google Cloud setup (one-time, ~15 minutes)

The Tasks API requires your own OAuth client. No verification, no billing.

1. [console.cloud.google.com](https://console.cloud.google.com) → create a project.
2. **APIs & Services → Library** → enable **Google Tasks API**.
3. **Google Auth Platform** (consent screen): User type **External** (Internal is Workspace-only). App name + your email. Scope: `https://www.googleapis.com/auth/tasks` (classified *sensitive*, not *restricted*: no security audit needed).
4. **Credentials → Create credentials → OAuth client ID → Desktop app** → download the JSON.
5. Save it as `~/.config/google-tasks-mcp/client_secret.json` (or point `GTASKS_MCP_CREDENTIALS` at it).
6. ⚠️ **The trap everyone hits:** while the consent screen's publishing status is **Testing**, refresh tokens expire every 7 days and you will re-auth weekly. Set publishing status to **In production** (skip verification; you'll click through a one-time "Google hasn't verified this app" interstitial: Advanced → Continue). Tokens then persist indefinitely.
7. Run `npx google-tasks-mcp auth`: a browser opens, you approve, the refresh token lands in `~/.config/google-tasks-mcp/token.json`. Done forever (revoking access or 6 months of disuse are the only expiries).

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `GTASKS_MCP_DIR` | `~/.config/google-tasks-mcp` | Config directory |
| `GTASKS_MCP_CREDENTIALS` | `<dir>/client_secret.json` | OAuth client file |
| `GTASKS_MCP_TOKEN` | `<dir>/token.json` | Cached refresh token |

## Tools

**Task lists:** `list_tasklists` · `get_tasklist` · `create_tasklist` · `update_tasklist` · `delete_tasklist`

**Tasks:** `list_tasks` (filters: completed/hidden/deleted, `updatedMin`, due bounds) · `get_task` · `create_task` · `update_task` · `complete_task` · `delete_task` · `move_task` (reorder, re-parent, or move across lists)

**Sync:** `diff_tasks(since, [tasklist])` · everything that changed after an RFC3339 timestamp, grouped per list into `completed` / `active` / `deleted`. Sweeps all lists unless one is specified.

## Design notes (API sharp edges, handled)

- **Due dates are date-only.** The API silently discards the time portion, and naive RFC3339 values can land a day off. Pass `YYYY-MM-DD`; the server normalizes to UTC midnight.
- **App-completed tasks go hidden.** Ticking a task in the Google Tasks app sets `hidden: true`; a plain list call never sees it again. `diff_tasks` always queries with `showCompleted + showHidden + showDeleted`, so nothing is missed.
- **No sync tokens.** Unlike the Calendar API, Tasks has no incremental sync token. `diff_tasks` uses `updatedMin`; keep a snapshot on your side and pass its timestamp.
- **`position` is read-only.** Reordering only works through `move_task` (parent + previous). This includes subtask nesting.
- **There is deliberately no `clear_completed` tool.** The API's `tasks.clear` wipes completed tasks from a list, which permanently destroys the evidence `diff_tasks` depends on. An LLM should not be able to call that casually. If you truly need it, the Tasks apps expose it in their UI.

## Development

```bash
git clone https://github.com/justerlex/google-tasks-mcp
cd google-tasks-mcp
npm install
npm run build
node dist/index.js auth   # one-time
node dist/index.js        # stdio server
```

One TypeScript file, ~450 lines: `src/index.ts`.

## License

[MIT](LICENSE)
