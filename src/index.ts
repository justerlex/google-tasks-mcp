#!/usr/bin/env node
/**
 * google-tasks-mcp · MCP server for the Google Tasks API.
 *
 * Full surface: task-list CRUD + task CRUD + move + a purpose-built
 * `diff_tasks` tool for harvesting changes since a timestamp.
 *
 * Auth is a one-time `google-tasks-mcp auth` run (browser OAuth via
 * @google-cloud/local-auth); the refresh token is cached to disk and the
 * server itself never opens a browser.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { google, tasks_v1 } from "googleapis";
import { authenticate } from "@google-cloud/local-auth";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import process from "node:process";

const VERSION = "0.1.0";
const SCOPES = ["https://www.googleapis.com/auth/tasks"];

const CONFIG_DIR =
  process.env.GTASKS_MCP_DIR ?? path.join(os.homedir(), ".config", "google-tasks-mcp");
const CREDENTIALS_PATH =
  process.env.GTASKS_MCP_CREDENTIALS ?? path.join(CONFIG_DIR, "client_secret.json");
const TOKEN_PATH = process.env.GTASKS_MCP_TOKEN ?? path.join(CONFIG_DIR, "token.json");

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

async function loadSavedClient() {
  try {
    const content = await fs.readFile(TOKEN_PATH, "utf-8");
    return google.auth.fromJSON(JSON.parse(content));
  } catch {
    return null;
  }
}

async function saveCredentials(client: { credentials: { refresh_token?: string | null } }) {
  const content = await fs.readFile(CREDENTIALS_PATH, "utf-8");
  const keys = JSON.parse(content);
  const key = keys.installed ?? keys.web;
  const payload = JSON.stringify(
    {
      type: "authorized_user",
      client_id: key.client_id,
      client_secret: key.client_secret,
      refresh_token: client.credentials.refresh_token,
    },
    null,
    2
  );
  await fs.mkdir(path.dirname(TOKEN_PATH), { recursive: true });
  await fs.writeFile(TOKEN_PATH, payload);
}

async function runAuthFlow(): Promise<void> {
  try {
    await fs.access(CREDENTIALS_PATH);
  } catch {
    console.error(
      `No OAuth client file at ${CREDENTIALS_PATH}\n` +
        `Create a Google Cloud "Desktop app" OAuth client and save its JSON there\n` +
        `(or point GTASKS_MCP_CREDENTIALS at it). Full runbook: README.md`
    );
    process.exit(1);
  }
  const client = await authenticate({ scopes: SCOPES, keyfilePath: CREDENTIALS_PATH });
  if (!client.credentials.refresh_token) {
    console.error(
      "Google returned no refresh token. Remove the app's access at " +
        "https://myaccount.google.com/permissions and run auth again."
    );
    process.exit(1);
  }
  await saveCredentials(client);
  console.error(`✓ Token saved to ${TOKEN_PATH}. The MCP server is ready to run.`);
}

let tasksApi: tasks_v1.Tasks | null = null;

async function api(): Promise<tasks_v1.Tasks> {
  if (tasksApi) return tasksApi;
  const client = await loadSavedClient();
  if (!client) {
    throw new Error(
      `No saved token at ${TOKEN_PATH}. Run \`npx google-tasks-mcp auth\` once to authenticate.`
    );
  }
  tasksApi = google.tasks({ version: "v1", auth: client as never });
  return tasksApi;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Google Tasks due dates are DATE-ONLY: the API discards any time portion.
 *  Accept bare YYYY-MM-DD and normalize to the UTC-midnight form the API
 *  expects, so callers never get an off-by-one-day surprise. */
function normalizeDue(due?: string): string | undefined {
  if (!due) return undefined;
  return /^\d{4}-\d{2}-\d{2}$/.test(due) ? `${due}T00:00:00.000Z` : due;
}

async function drainPages<T>(
  fetchPage: (pageToken?: string) => Promise<{ data: { items?: T[]; nextPageToken?: string | null } }>
): Promise<T[]> {
  const out: T[] = [];
  let pageToken: string | undefined;
  do {
    const res = await fetchPage(pageToken);
    out.push(...(res.data.items ?? []));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

const server = new McpServer({ name: "google-tasks-mcp", version: VERSION });

function register(
  name: string,
  description: string,
  shape: z.ZodRawShape,
  fn: (args: Record<string, unknown>) => Promise<unknown>
): void {
  server.tool(name, description, shape, async (args: Record<string, unknown>): Promise<ToolResult> => {
    try {
      return ok(await fn(args));
    } catch (e) {
      const err = e as { response?: { data?: { error?: { message?: string } } }; message?: string };
      const msg = err.response?.data?.error?.message ?? err.message ?? String(e);
      return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
    }
  });
}

// ---------------------------------------------------------------------------
// Task-list tools
// ---------------------------------------------------------------------------

register(
  "list_tasklists",
  "List all of the user's task lists (id, title, updated).",
  {},
  async () => {
    const t = await api();
    return drainPages((pageToken) => t.tasklists.list({ maxResults: 100, pageToken }));
  }
);

register(
  "get_tasklist",
  "Get a single task list by id.",
  { tasklist: z.string().describe("Task list id") },
  async (a) => {
    const t = await api();
    return (await t.tasklists.get({ tasklist: a.tasklist as string })).data;
  }
);

register(
  "create_tasklist",
  "Create a new task list. Emoji in titles render fine in the Google Tasks apps.",
  { title: z.string().describe("Title of the new task list") },
  async (a) => {
    const t = await api();
    return (await t.tasklists.insert({ requestBody: { title: a.title as string } })).data;
  }
);

register(
  "update_tasklist",
  "Rename a task list.",
  {
    tasklist: z.string().describe("Task list id"),
    title: z.string().describe("New title"),
  },
  async (a) => {
    const t = await api();
    return (
      await t.tasklists.patch({
        tasklist: a.tasklist as string,
        requestBody: { title: a.title as string },
      })
    ).data;
  }
);

register(
  "delete_tasklist",
  "Delete a task list AND all tasks in it. Irreversible: confirm intent before calling.",
  { tasklist: z.string().describe("Task list id") },
  async (a) => {
    const t = await api();
    await t.tasklists.delete({ tasklist: a.tasklist as string });
    return { deleted: a.tasklist };
  }
);

// ---------------------------------------------------------------------------
// Task tools
// ---------------------------------------------------------------------------

register(
  "list_tasks",
  "List tasks in a task list. By default returns only active (needsAction) tasks; " +
    "set the show* flags for completed/hidden/deleted ones. Note: tasks completed in the " +
    "Google Tasks apps become hidden, so harvesting completions needs showCompleted AND showHidden.",
  {
    tasklist: z.string().describe("Task list id"),
    showCompleted: z.boolean().optional().describe("Include completed tasks (default false)"),
    showHidden: z.boolean().optional().describe("Include hidden tasks (default false)"),
    showDeleted: z.boolean().optional().describe("Include deleted tasks (default false)"),
    updatedMin: z
      .string()
      .optional()
      .describe("RFC3339 timestamp; only tasks updated after this moment"),
    dueMin: z.string().optional().describe("RFC3339 lower bound on due date"),
    dueMax: z.string().optional().describe("RFC3339 upper bound on due date"),
  },
  async (a) => {
    const t = await api();
    return drainPages((pageToken) =>
      t.tasks.list({
        tasklist: a.tasklist as string,
        maxResults: 100,
        pageToken,
        showCompleted: (a.showCompleted as boolean | undefined) ?? false,
        showHidden: (a.showHidden as boolean | undefined) ?? false,
        showDeleted: (a.showDeleted as boolean | undefined) ?? false,
        updatedMin: a.updatedMin as string | undefined,
        dueMin: a.dueMin as string | undefined,
        dueMax: a.dueMax as string | undefined,
      })
    );
  }
);

register(
  "get_task",
  "Get a single task by id.",
  {
    tasklist: z.string().describe("Task list id"),
    task: z.string().describe("Task id"),
  },
  async (a) => {
    const t = await api();
    return (await t.tasks.get({ tasklist: a.tasklist as string, task: a.task as string })).data;
  }
);

register(
  "create_task",
  "Create a task. Due dates are DATE-ONLY in Google Tasks (any time portion is discarded); " +
    "pass YYYY-MM-DD and it is normalized safely.",
  {
    tasklist: z.string().describe("Task list id"),
    title: z.string().describe("Task title"),
    notes: z.string().optional().describe("Free-text notes on the task"),
    due: z.string().optional().describe("Due date, YYYY-MM-DD (or full RFC3339)"),
    parent: z.string().optional().describe("Parent task id, to create as a subtask"),
    previous: z.string().optional().describe("Sibling task id to insert after"),
  },
  async (a) => {
    const t = await api();
    return (
      await t.tasks.insert({
        tasklist: a.tasklist as string,
        parent: a.parent as string | undefined,
        previous: a.previous as string | undefined,
        requestBody: {
          title: a.title as string,
          notes: a.notes as string | undefined,
          due: normalizeDue(a.due as string | undefined),
        },
      })
    ).data;
  }
);

register(
  "update_task",
  "Update a task's title, notes, due date, or status (needsAction | completed).",
  {
    tasklist: z.string().describe("Task list id"),
    task: z.string().describe("Task id"),
    title: z.string().optional().describe("New title"),
    notes: z.string().optional().describe("New notes"),
    due: z.string().optional().describe("New due date, YYYY-MM-DD (or full RFC3339)"),
    status: z.enum(["needsAction", "completed"]).optional().describe("New status"),
  },
  async (a) => {
    const t = await api();
    const body: tasks_v1.Schema$Task = {};
    if (a.title !== undefined) body.title = a.title as string;
    if (a.notes !== undefined) body.notes = a.notes as string;
    if (a.due !== undefined) body.due = normalizeDue(a.due as string);
    if (a.status !== undefined) body.status = a.status as string;
    return (
      await t.tasks.patch({
        tasklist: a.tasklist as string,
        task: a.task as string,
        requestBody: body,
      })
    ).data;
  }
);

register(
  "complete_task",
  "Mark a task completed (shorthand for update_task with status=completed).",
  {
    tasklist: z.string().describe("Task list id"),
    task: z.string().describe("Task id"),
  },
  async (a) => {
    const t = await api();
    return (
      await t.tasks.patch({
        tasklist: a.tasklist as string,
        task: a.task as string,
        requestBody: { status: "completed" },
      })
    ).data;
  }
);

register(
  "delete_task",
  "Delete a single task.",
  {
    tasklist: z.string().describe("Task list id"),
    task: z.string().describe("Task id"),
  },
  async (a) => {
    const t = await api();
    await t.tasks.delete({ tasklist: a.tasklist as string, task: a.task as string });
    return { deleted: a.task };
  }
);

register(
  "move_task",
  "Reorder a task (position is read-only; this is the only way to reorder), re-parent it " +
    "as a subtask, or move it to another list via destinationTasklist.",
  {
    tasklist: z.string().describe("Current task list id"),
    task: z.string().describe("Task id"),
    parent: z.string().optional().describe("New parent task id (omit for top level)"),
    previous: z.string().optional().describe("Sibling task id to place after (omit for first position)"),
    destinationTasklist: z.string().optional().describe("Target task list id, to move across lists"),
  },
  async (a) => {
    const t = await api();
    return (
      await t.tasks.move({
        tasklist: a.tasklist as string,
        task: a.task as string,
        parent: a.parent as string | undefined,
        previous: a.previous as string | undefined,
        destinationTasklist: a.destinationTasklist as string | undefined,
      })
    ).data;
  }
);

// ---------------------------------------------------------------------------
// Diff tool
// ---------------------------------------------------------------------------

register(
  "diff_tasks",
  "Harvest every change since a timestamp: returns tasks updated after `since`, grouped per " +
    "list into completed / active / deleted. Queries with showCompleted+showHidden+showDeleted " +
    "so completions made in the Google Tasks apps (which become hidden) are not missed. " +
    "Omit `tasklist` to sweep every list. The API has no sync tokens; keep your own snapshot " +
    "and pass its timestamp as `since`.",
  {
    since: z.string().describe("RFC3339 timestamp, e.g. 2026-07-20T00:00:00.000Z"),
    tasklist: z.string().optional().describe("Limit to one task list id (default: all lists)"),
  },
  async (a) => {
    const t = await api();
    const lists = a.tasklist
      ? [(await t.tasklists.get({ tasklist: a.tasklist as string })).data]
      : await drainPages((pageToken) => t.tasklists.list({ maxResults: 100, pageToken }));

    const result = [];
    for (const list of lists) {
      const changed = await drainPages<tasks_v1.Schema$Task>((pageToken) =>
        t.tasks.list({
          tasklist: list.id!,
          maxResults: 100,
          pageToken,
          updatedMin: a.since as string,
          showCompleted: true,
          showHidden: true,
          showDeleted: true,
        })
      );
      if (changed.length === 0) continue;
      result.push({
        list: { id: list.id, title: list.title },
        completed: changed.filter((x) => !x.deleted && x.status === "completed"),
        active: changed.filter((x) => !x.deleted && x.status !== "completed"),
        deleted: changed.filter((x) => x.deleted),
      });
    }
    return { since: a.since, changedLists: result.length, changes: result };
  }
);

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const cmd = process.argv[2];
  if (cmd === "auth") {
    await runAuthFlow();
    return;
  }
  if (cmd && cmd !== "serve") {
    console.error(`Unknown command "${cmd}". Usage: google-tasks-mcp [auth]`);
    process.exit(1);
  }
  await server.connect(new StdioServerTransport());
  // stdout is the MCP protocol channel; all human output goes to stderr.
  console.error(`google-tasks-mcp v${VERSION} running on stdio`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
