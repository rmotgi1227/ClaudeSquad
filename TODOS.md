# TODOS — claude-squad

## P2: Intention claims (v2)
**What:** `propose_change(file, intent)` tool. Before editing a file, broadcast what you intend to do. Others see "Backend intends to refactor auth.ts — JWT migration." Auto-approve after 30s silence.
**Why:** Turns the channel from a message board into a code negotiation layer. Strong differentiator.
**Effort:** L (human: ~3 days / CC: ~45 min)
**Start:** Add `type: 'proposal'` to messages table, add `propose_change` + `approve_proposal` tools, wire into PreToolUse hook.

## P3: SSE / WebSocket push (v2)
**What:** Real-time push notifications to connected instances when new messages arrive.
**Why:** Currently pull-based (instances poll on tool call). Push would enable true real-time.
**Start:** Upgrade after polling proves insufficient based on user feedback.

## P2: Message retention / auto-pruning (v1.5)
**What:** Prune messages older than 7 days on daemon startup. Add `PRAGMA auto_vacuum = INCREMENTAL` to keep SQLite file size bounded.
**Why:** Without pruning, `~/.claude-squad/state.db` grows unbounded. At 1000 messages/day, that's 7MB/week — noticeable within a month.
**Start:** Add `DELETE FROM messages WHERE created_at < unixepoch() - 604800` to daemon startup sequence.

## P3: Persistent daemon connection (v2)
**What:** bridge.ts maintains a single long-lived Unix socket connection to the daemon instead of a new connection per RPC call.
**Why:** Enables future push notifications (daemon pushes new messages to bridges) without a separate WebSocket layer. Current per-call latency is <1ms — not a bottleneck today.
**Depends on:** SSE/WebSocket push scope decision.
**Start:** Replace `connectSocket()` per-call pattern with a module-level socket instance, add reconnect-on-error logic.

## P3: Per-instance unread count (v1.2)
**What:** Track `last_read_at` per instance in the instances table. Status line shows unread count specific to THIS instance, not total recent messages across the whole machine.
**Why:** Current v1.1 status cache shows total recent messages in the last 30 min. More accurate unread badge improves the ambient awareness UX.
**Depends on:** Persistent connection (so bridge efficiently updates last_read_at without a new socket per RPC), or a dedicated `mark_read` RPC call.
**Start:** Re-add `last_read_at INTEGER NOT NULL DEFAULT 0` to instances table migration, add `mark_read` RPC, update status cache to write per-instance counts.

## P3: Cursor / Copilot adapters (community)
**What:** Community-maintained adapters so Cursor and GitHub Copilot can connect to claude-squad.
**Why:** Platform play — becomes the universal local agent coordination layer.
**Start:** Document the MCP interface clearly in README so community can build adapters.
