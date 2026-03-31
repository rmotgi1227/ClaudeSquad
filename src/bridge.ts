#!/usr/bin/env node
/**
 * ccsquad MCP bridge
 * One of these runs per Claude Code instance (stdio transport).
 * Connects to the shared daemon, exposes MCP tools.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as path from "path";
import { execSync } from "child_process";
import { daemonRpc } from "./client.js";
import { makeInstanceId, nowMs, getRepoId, formatAge, DEFAULT_MESSAGES_LIMIT, type Standup } from "./types.js";

const STARTUP_TS = nowMs();
const PID = process.pid;

const INSTANCE_NAME = process.env.CCSQUAD_NAME || path.basename(process.cwd());
const CWD = process.cwd();

function getCurrentBranch(): string | null {
  try {
    return execSync("git branch --show-current", { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim() || null;
  } catch {
    return null;
  }
}

let instanceId: string | null = null;
// Resolved once at startup; stable for the lifetime of this process
let instanceRepo: string = getRepoId(CWD);

// Standup notice: set on registration, prepended to the first tool call response
let pendingStandup: string | null = null;
let firstCallDone = false;

async function register(): Promise<string> {
  const branch = getCurrentBranch();
  const result = await daemonRpc("register", {
    name: INSTANCE_NAME,
    cwd: CWD,
    branch,
    repo: instanceRepo,
    pid: PID,
    startup_ts: STARTUP_TS,
  }) as { instance_id: string; standup: Standup };

  const { active_instances, inbox_count } = result.standup ?? {};

  const notices: string[] = [];

  if (active_instances?.length) {
    const others = active_instances.filter(
      (i) => i.name !== INSTANCE_NAME || i.cwd !== CWD
    );
    if (others.length) {
      const names = others
        .map((i) => `${i.name}${i.branch ? `@${i.branch}` : ""} (${formatAge(i.last_seen)})`)
        .join(", ");
      notices.push(`[Squad: ${others.length} instance${others.length > 1 ? "s" : ""} active — ${names}. Call read_messages to catch up.]`);
    }
  }

  if (inbox_count && inbox_count > 0) {
    notices.push(`[${inbox_count} question${inbox_count > 1 ? "s" : ""} waiting for you — call check_inbox() to review.]`);
  }

  if (notices.length > 0) {
    pendingStandup = notices.join(" ");
  }

  return result.instance_id;
}

const server = new Server(
  { name: "ccsquad", version: "1.2.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "broadcast",
      description: "Share important context with all other Claude Code instances on this machine. Use this for decisions, conventions, or anything others should know.",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string", description: "The message to broadcast (max 10KB)" },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Optional tags to categorize (e.g. ['db-schema', 'auth'])",
          },
        },
        required: ["message"],
      },
    },
    {
      name: "read_messages",
      description: "Read recent messages from the shared channel. Call this when starting work or when you want to know what other instances have shared.",
      inputSchema: {
        type: "object",
        properties: {
          since: { type: "number", description: "Millisecond timestamp — only return messages after this time" },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Filter by tags",
          },
          limit: { type: "number", description: `Number of messages to return (default ${DEFAULT_MESSAGES_LIMIT}, max 20)` },
        },
      },
    },
    {
      name: "ask",
      description: "Post a question to the squad. Other instances can answer it.",
      inputSchema: {
        type: "object",
        properties: {
          question: { type: "string", description: "The question to ask" },
          context: { type: "string", description: "Optional context to help others answer" },
        },
        required: ["question"],
      },
    },
    {
      name: "ask_instance",
      description: "Ask a specific instance a directed question. Use list_instances() first to get slot numbers. The question is visible to all but delivered to the target.",
      inputSchema: {
        type: "object",
        properties: {
          target: {
            description: "Slot number (e.g. 2) or exact instance name (e.g. 'backend'). Use slot number when names are ambiguous.",
            oneOf: [
              { type: "number" },
              { type: "string" },
            ],
          },
          question: { type: "string", description: "The question to ask" },
          context: { type: "string", description: "Optional context to help the target answer" },
          wait: { type: "boolean", description: "If true, wait up to wait_timeout_ms for an answer before returning (default false)" },
          wait_timeout_ms: { type: "number", description: "How long to wait for an answer in ms (default 30000). Useful for tests." },
        },
        required: ["target", "question"],
      },
    },
    {
      name: "check_inbox",
      description: "See unanswered questions directed specifically at you. Use answer() to respond.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "answer",
      description: "Respond to a question posted by another instance.",
      inputSchema: {
        type: "object",
        properties: {
          question_id: { type: "number", description: "The message ID of the question to answer" },
          answer: { type: "string", description: "Your answer" },
        },
        required: ["question_id", "answer"],
      },
    },
    {
      name: "list_instances",
      description: "See all active Claude Code instances on this machine — their slot numbers, names, branches, and last activity.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "set_shared",
      description: "Pin a structured fact in the shared KV store (e.g. db schema, error conventions). Max 50KB per value.",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string", description: "Key name (e.g. 'db_schema', 'error_convention')" },
          value: { type: "string", description: "Value to store" },
        },
        required: ["key", "value"],
      },
    },
    {
      name: "get_shared",
      description: "Retrieve a fact from the shared KV store by key.",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string", description: "Key to retrieve" },
        },
        required: ["key"],
      },
    },
  ],
}));

async function handleTool(
  name: string,
  args: Record<string, unknown>,
  id: string
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  switch (name) {
      case "broadcast": {
        const result = await daemonRpc("broadcast", {
          instance_id: instanceId,
          content: args.message as string,
          tags: args.tags as string[] | undefined,
        }) as { message_id: number };
        return {
          content: [{ type: "text", text: `Broadcast sent (id: ${result.message_id})` }],
        };
      }

      case "read_messages": {
        const result = await daemonRpc("read_messages", {
          since: args.since,
          tags: args.tags,
          limit: args.limit,
          repo: instanceRepo,
        }) as { messages: unknown[] };
        const msgs = result.messages;
        if (msgs.length === 0) {
          return { content: [{ type: "text", text: "No messages yet." }] };
        }
        const formatted = msgs
          .map((m: unknown) => {
            const msg = m as {
              instance_name?: string;
              to_instance_name?: string;
              type: string;
              content: string;
              created_at: number;
              id: number;
              tags?: string[];
              to_instance_id?: string | null;
            };
            const age = formatAge(msg.created_at);
            const tag = msg.tags?.length ? ` [${msg.tags.join(", ")}]` : "";
            const directed = msg.to_instance_id && msg.to_instance_name ? ` → @${msg.to_instance_name}` : "";
            const prefix = msg.type === "ask" ? `Q#${msg.id}` : msg.type === "answer" ? "A" : "→";
            return `${prefix} ${msg.instance_name || "unknown"}${directed} (${age})${tag}: ${msg.content}`;
          })
          .join("\n");
        return { content: [{ type: "text", text: formatted }] };
      }

      case "ask": {
        const result = await daemonRpc("ask", {
          instance_id: instanceId,
          question: args.question as string,
          context: args.context as string | undefined,
        }) as { message_id: number };
        return {
          content: [{ type: "text", text: `Question posted (id: ${result.message_id}). Others can answer it with answer(question_id: ${result.message_id}, answer: "...")` }],
        };
      }

      case "ask_instance": {
        const wait = args.wait as boolean | undefined;
        const waitTimeoutMs = (args.wait_timeout_ms as number | undefined) ?? 30000;

        const result = await daemonRpc("ask_instance", {
          instance_id: instanceId,
          target: args.target,
          question: args.question as string,
          context: args.context as string | undefined,
          repo: instanceRepo,
        }) as {
          message_id: number;
          question_id: number;
          target_name: string;
          target_last_seen: number;
          stale_warning: string | null;
        };

        const questionId = result.question_id;
        let text = `Question posted to @${result.target_name} (id: ${questionId}).`;
        if (result.stale_warning) {
          text += ` Warning: ${result.stale_warning}`;
        }

        if (!wait) {
          return { content: [{ type: "text", text }] };
        }

        // wait=true: poll for answer every 2s
        const pollIntervalMs = 2000;
        const deadline = nowMs() + waitTimeoutMs;

        while (nowMs() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
          const pollResult = await daemonRpc("read_messages", {
            repo: instanceRepo,
            reply_to_id: questionId,
            limit: 1,
          }) as { messages: unknown[] };

          if (pollResult.messages.length > 0) {
            const answer = pollResult.messages[0] as { instance_name?: string; content: string };
            return {
              content: [{
                type: "text",
                text: `Answer from @${answer.instance_name || "unknown"}: ${answer.content}`,
              }],
            };
          }
        }

        return {
          content: [{
            type: "text",
            text: `No answer in ${Math.round(waitTimeoutMs / 1000)}s. Question still open (id: ${questionId}).`,
          }],
        };
      }

      case "check_inbox": {
        const result = await daemonRpc("check_inbox", {
          instance_id: instanceId,
        }) as { questions: unknown[] };

        const questions = result.questions;
        if (questions.length === 0) {
          return { content: [{ type: "text", text: "No pending questions." }] };
        }

        const formatted = questions
          .map((q: unknown) => {
            const msg = q as { id: number; instance_name?: string; content: string; created_at: number };
            const age = formatAge(msg.created_at);
            return `Q#${msg.id} ${msg.instance_name || "unknown"} (${age}): ${msg.content}`;
          })
          .join("\n");

        return { content: [{ type: "text", text: formatted }] };
      }

      case "answer": {
        const result = await daemonRpc("answer", {
          instance_id: instanceId,
          question_id: args.question_id as number,
          answer: args.answer as string,
        }) as { message_id: number };
        return {
          content: [{ type: "text", text: `Answer posted (id: ${result.message_id})` }],
        };
      }

      case "list_instances": {
        const result = await daemonRpc("list_instances", { repo: instanceRepo }) as { instances: unknown[] };
        const instances = result.instances;
        if (instances.length === 0) {
          return { content: [{ type: "text", text: "No active instances." }] };
        }
        const formatted = instances
          .map((inst: unknown) => {
            const i = inst as { name: string; branch?: string; cwd: string; last_seen: number; id: string; slot: number | null };
            const me = i.id === instanceId ? " (you)" : "";
            const branch = i.branch ? `@${i.branch}` : "";
            const age = i.last_seen === 0 ? "offline" : formatAge(i.last_seen);
            const slot = i.slot != null ? `#${i.slot} ` : "";
            return `• ${slot}${i.name}${branch}${me} — ${path.basename(i.cwd)} (${age})`;
          })
          .join("\n");
        return { content: [{ type: "text", text: formatted }] };
      }

      case "set_shared": {
        await daemonRpc("set_shared", {
          instance_id: instanceId,
          key: args.key as string,
          value: args.value as string,
        });
        return { content: [{ type: "text", text: `Shared key '${args.key}' set.` }] };
      }

      case "get_shared": {
        const result = await daemonRpc("get_shared", {
          key: args.key as string,
          repo: instanceRepo,
        }) as { entry: unknown };
        if (!result.entry) {
          return { content: [{ type: "text", text: `Key '${args.key}' not found.` }] };
        }
        const entry = result.entry as { value: string; set_by: string; updated_at: number };
        return {
          content: [{
            type: "text",
            text: `${args.key}: ${entry.value}\n(set by ${entry.set_by}, ${formatAge(entry.updated_at)} ago)`,
          }],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (!instanceId) {
    instanceId = await register();
  }

  const { name, arguments: args = {} } = req.params;

  let result: { content: Array<{ type: string; text: string }>; isError?: boolean };
  try {
    result = await handleTool(name, args as Record<string, unknown>, instanceId);
  } catch (err) {
    result = {
      content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }

  // Prepend standup notice on the first tool call of this bridge process
  if (!firstCallDone && pendingStandup) {
    firstCallDone = true;
    const notice = pendingStandup;
    pendingStandup = null;
    result = {
      ...result,
      content: [{ type: "text" as const, text: notice }, ...result.content],
    };
  }

  return result;
});

async function main(): Promise<void> {
  setInterval(async () => {
    if (instanceId) {
      const branch = getCurrentBranch();
      await daemonRpc("heartbeat", { instance_id: instanceId, branch }).catch(() => {});
    }
  }, 60_000);

  process.on("SIGTERM", async () => {
    if (instanceId) {
      await daemonRpc("mark_offline", { instance_id: instanceId }).catch(() => {});
    }
    process.exit(0);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`bridge error: ${err.message}\n`);
  process.exit(1);
});
