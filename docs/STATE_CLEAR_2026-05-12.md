# Conversation state clear — 2026-05-12

**Trigger:** Atlas's in-memory `conversations` Map (agent.js:1256) accumulated a corrupted message history for `conversation_id: "telegram-6501185066"`. An orphan `tool_use_id: toolu_01HGpM3vXVVt3oi82PJwhAWN` lived at `messages.0.content.0` as a `tool_result` without a matching `tool_use` in any prior assistant message. Anthropic API rejected every subsequent turn with HTTP 400 (`invalid_request_error: unexpected tool_use_id found in tool_result blocks`).

**Impact:** All Telegram→Atlas replies returned `(empty reply)` for the affected conversation_id. Captured in n8n executions 560/561/562 of workflow `xVFSLdDTCEbzqvVg`.

**Fix mechanism:** This commit forces Railway to redeploy `crown-key-pa`. Because conversation state is held in an in-process `Map` (no persistence), a cold start of the Node process clears it.

**Forensic capture:**
- `/home/u153709808/reports/atlas_state_backup_2026-05-12.json` — full n8n execution dump (10 most recent Telegram PA executions)
- `/home/u153709808/reports/atlas_orphan_forensic_2026-05-12.json` — focused excerpt of the 2 failing calls with the orphan id verbatim

**Recommended follow-up:** add an authenticated `/admin/clear-conversation?id=<conv_id>` endpoint to `server.js` so future corruption can be cleared per-conversation without a full redeploy.
