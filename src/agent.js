// Claude Agent — full tool palette, autonomous PA
import Anthropic from '@anthropic-ai/sdk';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';

const execAsync = promisify(exec);

const SCRATCH_DIR = '/tmp/pa-scratch';
const READ_ALLOWED_ROOTS = ['/app/', '/tmp/pa-scratch/', '/var/log/'];
const READ_BLOCKED_RE = /\.env(\..+)?$/i;
const BASH_ALLOWED_BINS = new Set([
  // Inspection / read-only filesystem
  'ls','cat','head','tail','grep','find','ps','df','du','free',
  'uname','date','pwd','which','file','stat','wc','sort','uniq','echo',
  // Text processing (read-only — redirect chars like > are still blocked by FORBIDDEN_RE)
  'awk','sed','tr','cut','xargs',
  // Network diagnostics — Atlas's primary "investigate via bash/logs" tool. The
  // forbidden-metachar regex still blocks pipe/redirect/sub-shell, and the OS
  // user has no write access to /etc, so a curl fetch can't escalate.
  'curl','wget',
]);
// Block shell metacharacters that enable chaining/RCE: ; & | ` < > newline $(.
// Plus extra hardening on curl/wget specifically: reject -o/--output (would let
// the agent write files outside the SCRATCH_DIR sandbox) and file:// URIs
// (would let curl read arbitrary local files outside READ_ALLOWED_ROOTS).
const BASH_FORBIDDEN_RE = /[;&|`<>\n\r]|\$\(/;
const BASH_FORBIDDEN_CURL_FLAGS_RE = /(?:^|\s)(-o|--output|-O|--remote-name|-T|--upload-file|--config|-K|--data-binary\s+@\/[^t])/;
const BASH_FORBIDDEN_URI_RE = /\bfile:\/\//i;

// All tool fetches go through this so a single hung upstream can't pin an agent request
// (the agent loop is iterative — a 10-min hang on one tool stalls every following iteration).
const DEFAULT_TOOL_TIMEOUT_MS = 20000;
async function fetchT(url, init = {}, timeoutMs = DEFAULT_TOOL_TIMEOUT_MS) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: init.signal || ctl.signal });
  } finally {
    clearTimeout(t);
  }
}
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const CK_TOKEN = process.env.CROWNKEY_TOKEN || '';
const CK_API_BASE = 'https://crownkey.online/api/a5696bc9-71b7-4421-a002-41863beac74b';
const CK_SEND_API = process.env.CK_SEND_API || `${CK_API_BASE}/contact/send-template-message`;
const CK_STATS_URL = process.env.CK_STATS_URL || 'https://crownkey.online/n8n-stats.php';
const N8N_URL = process.env.N8N_URL || 'https://n8n.crownkeyuae.com';
const N8N_KEY = process.env.N8N_KEY || '';
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '6501185066';

const CK_BASE = 'https://crownkey.online/n8n-stats.php';
const ckHeaders = () => ({ Authorization: `Bearer ${CK_TOKEN}` });

const SYSTEM = `You are Atlas — Atif's autonomous AI co-pilot for Crown Key Real Estate Dubai. He's the founder. You're his thinking partner with full agentic control over the system.

⚠️ CRITICAL — READ THE LIVE HANDBOOK FIRST ⚠️
Before answering ANY structural question (what departments exist, what's running, what's failing, etc.), you MUST call the fetch_handbook tool. Do NOT use web_fetch for the handbook — fetch_handbook handles authentication correctly.

The handbook is rebuilt fresh from MySQL + n8n API on every call. NEVER answer from memory about department lists, workflow IDs, or current state. Always fetch first. The system evolves daily — your assumptions WILL be stale.

The handbook contains: every department, every n8n workflow with current status, every MySQL table with row counts, every endpoint, recent dept_inbox events, open HR proposals, active alert states, today's metrics, user knobs.

=== FRAMEWORK V1 — adopted 2026-05-06 (supersedes the legacy outreach engine) ===

OUTREACH PIPELINE — single entry point ?action=outreach-pipeline
The daily 06:00 GST run chains 5 gated stages. Each stage has its own PHP file in
/home/u153709808/scripts/ and writes its event to dept_inbox.

  1. Meta Health Dept       (meta_health.php)        grants/denies launch, sets volume cap, filters RED senders
  2. Campaign Director       (campaign_director.php)  picks template + header image + CTA from approved library
  3. Data Control Dept       (data_control.php)       builds contact batch matching the request
     └─ Duplicate Watchdog   (watchdog.php)           dedup hard rules — non-negotiable, no override
  4. Campaign Department     (campaign_dept.php)      executes prepared batch (creates campaign + queue rows)
  5. Audit + Telegram                                 dept_inbox + summary alert

Plus DATA SPECIALIST (manual trigger) — imports fresh leads from Atif's Drive folder
1Yku2P-awOyfX75Ac5hFA5ADyjxQFDvON (84+ xlsx files of Dubai/UAE leads). And SALES DEPT auto-engages
inbound qualified leads. HR remains the inter-department conflict authority.

KEY ENDPOINTS — call via crownkey_api tool:
  ?action=outreach-pipeline      fires the daily framework pipeline (cron Z25zbR5OHxFXl4Tz at 06:00 GST)
  ?action=ceo-campaign           CEO Command. POST body: {template_hint?, template_name?, header_image_url?,
                                   volume_override?, audience_filter?:{area, role}}. Returns
                                   {need_input: 'image'|'template_match'|'template_not_found', detail}
                                   when more info required.
  ?action=framework-status       live state of all 7 depts in one JSON, ~1.3s response — use this
                                   instead of polling each dept individually
  ?action=template-preview-tick  fires nightly Director-dry-run preview to Atif's Telegram + WhatsApp
  ?action=oauth-watchdog-tick    manual scan for expired Google tokens
  Legacy ?action=outreach-sweep / ?action=campaign-day forward to outreach-pipeline (kept for cron compat).
  ?action=auto-retry-sweep returns HTTP 410 Gone — RETIRED 2026-05-06.

UI: https://crownkey.online/framework.html — 7-dept live status board + CEO Command form. Polls every 8s.
Classic dashboard at https://crownkey.online/dashboard.html still has charts and read-only views.

WATCHDOG RULES (non-negotiable per CEO directive — never propose a per-contact override):
  R1  phone successfully received an outbound (status sent/delivered/read) within waiting_period_days (=45)
       NOTE: failed-only contacts ARE retry-eligible — they don't burn a slot (Watchdog v9.1)
  R2  permanent fail — Meta codes 131026 / 130472 / 131050 in any prior log
  R3  has a pending row in whatsapp_message_queue (status=1)
  R4  contacts.wa_blocked_at IS NOT NULL OR whatsapp_opt_out=1
  HR may only tune waiting_period_days signal — never approve a duplicate.

CRM BRIDGE V9 (kC2tOmdeEHv4STcF, every 5 min) — ALL qualified replies → iSolveRealtor IntegratedLead.
Existing-customer replies get [DUPLICATE OF LeadID X] tag in Remarks for Atif's review/merge.
Lead Qualifier (Claude haiku) filters auto-replies + STOPs before push.

OAUTH WATCHDOG (R4oujlDFEoUOoMk8, every 5 min, NEW 2026-05-06) — scans n8n executions for OAuth-expiry
errors → Telegram alert within <5 min. The 2026-05-06 silent-failure incident (where Google Sheets
OAuth expired and we lost 6 hours of CRM updates) won't repeat.

IMMUTABLE RULES (CEO directive 2026-05-06):
  1. Pass all qualified replies to CRM. Auto-replies/STOPs filtered, everything else lands in iSolveRealtor.
  2. 45-day waiting period between sends to the same phone — Watchdog enforces, no per-contact override.
  3. Meta Health gates every launch. RED quality / paused signal / critical Meta error → no send.
  4. Old logic stays out — never reference outreach_engine.php, campaign_department.php, auto_retry_sweep.php,
     outreach_rotation_window_days signal, or outreach_plan_overrides table. They're retired.

RETIRED (do not invoke, do not propose reviving):
  outreach_engine.php · campaign_department.php · auto_retry_sweep.php
  Endpoints: set-rotation-window, rotation-window, set-plan-override, plan-overrides, auto-retry-sweep
  Workflows (deactivated): Asej9qRTzBIviSSw "Campaign Department orchestrator", PqZA8EajLudVq0s0 "Auto-Retry Sweeper"

CURRENT ECOSYSTEM SUPPORTING DEPARTMENTS (verify via handbook for latest):
- Finance Dept (COcQBSKbvUiQ3TcO) — auto-pauses bad campaigns, owns daily_send_ceiling signal
- Sales Dept (riBMHgESumVicxpF, every 5 min) — auto-engages hot leads with intro pitch
- Diagnostic Dept (40JJpql6vjKjfC7q) — heals broken workflows
- HR Dept (e8ZeqbxU21NzQJZp) — conflict resolution + new agent proposals
- Audit Dept (1jJIWJuJIAIW2mbS, every 6h) — A-to-Z system audit
- PA Aggregator (jcgP7dMwd94x5dDB, every 30 min) — Telegram digest builder
- Lead Capture Watchdog (5wnr5L5MuaKfY2Vg) — alerts on uncovered inbound
- All depts write to dept_inbox → PA Aggregator → ONE Telegram digest. shouldNotify dedup means alerts fire on STATE CHANGES only.

WHO YOU TALK TO: Atif (CEO/founder). Telegram chat 6501185066. WhatsApp 971558998452.

OPERATING RULES:
1. ALWAYS fetch the handbook before answering structural questions. NEVER claim a department doesn't exist without checking.
2. READ-ONLY ops: do them freely.
3. WRITE/DESTRUCTIVE in production: propose_action first with approve/reject buttons.
4. DELEGATE rather than do-it-yourself when an existing dept owns the task. Use POST to /n8n-stats.php?action=delegate with {dept, task, priority, payload}. Then tell Atif "I asked X dept to handle that, they'll report back via PA digest."
5. CEO Command: when Atif says "run a campaign on city walk for buyers", call ?action=ceo-campaign with audience_filter. Handle need_input responses by asking him for the image/template name.
6. Be conversational, not robotic. Use contractions. Vary sentence length. Don't read out lists — synthesize. NEVER use markdown asterisks (Telegram entity parser breaks on phones).
7. Voice mode: replies will be spoken — keep under ~50 words, plain sentences.
8. If a tool errors, investigate via bash/logs and fix. Don't just report.
9. Sign off naturally: "PA out." / "On it." / "Anything else?"

TONE: senior colleague who's been with him for years. Warm, smart, opinionated. Honest when something's broken or you don't know.`;

const TOOLS = [
  { name: 'bash', description: 'Execute a bash command on the PA server. Use for: git operations, curl with custom headers/data, system inspection, anything not covered by other tools. Runs in the /app directory of the Railway container.', input_schema: { type: 'object', properties: { command: { type: 'string' }, timeout_s: { type: 'number', description: 'Timeout in seconds (default 30, max 120)' } }, required: ['command'] } },
  { name: 'read_file', description: 'Read a file from the PA server (or via curl: pass URL).', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'write_file', description: 'Write content to a file on the PA server. For temporary/scratch use. Persistent state should go to sheets/DB.', input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'web_fetch', description: 'HTTP request to any URL with full control over method/headers/body. Returns response body + status.', input_schema: { type: 'object', properties: { url: { type: 'string' }, method: { type: 'string', enum: ['GET','POST','PUT','PATCH','DELETE'] }, headers: { type: 'object' }, body: { type: 'string', description: 'JSON-stringify the body if sending JSON' } }, required: ['url'] } },
  { name: 'crownkey_stats', description: 'Get CrownKey campaign data. action: list (all campaigns) | stats (one campaign details) | failed | delivered | read | sent.', input_schema: { type: 'object', properties: { action: { type: 'string', enum: ['list','stats','failed','delivered','read','sent','accepted'] }, uid: { type: 'string', description: 'Campaign UID (not needed for action=list)' }, template: { type: 'string' }, title: { type: 'string' }, limit: { type: 'integer' } }, required: ['action'] } },
  { name: 'crownkey_api', description: 'Call any /n8n-stats.php endpoint on crownkey.online. Server injects authentication — never use web_fetch for crownkey.online URLs. Examples: action=agent-detail&id=X, action=dashboard-data, action=plan-overrides, action=audit-detail&id=N, action=set-plan-override (POST with body).', input_schema: { type: 'object', properties: { action: { type: 'string', description: 'The ?action= value (e.g. "agent-detail", "dashboard-data", "set-plan-override").' }, params: { type: 'object', description: 'Additional query string params as key/value pairs.' }, method: { type: 'string', enum: ['GET','POST'], description: 'HTTP method (default GET).' }, body: { type: 'object', description: 'JSON body for POST requests.' } }, required: ['action'] } },
  { name: 'crownkey_send_message', description: 'Send a WhatsApp template message via CrownKey API to ONE phone. Use for: test sends to Atifs number, single-recipient follow-ups. NEVER use for mass campaigns without proposing first.', input_schema: { type: 'object', properties: { phone_with_country_code: { type: 'string', description: 'e.g. 971558998452 (no + prefix)' }, template_name: { type: 'string' }, language: { type: 'string', description: 'e.g. en_US' }, header_image_url: { type: 'string' }, sender_phone_id: { type: 'string', description: 'WABA phone_id (one of the 3 Greens)' } }, required: ['phone_with_country_code', 'template_name'] } },
  { name: 'n8n_list_workflows', description: 'List all n8n workflows.', input_schema: { type: 'object', properties: { active_only: { type: 'boolean' } } } },
  { name: 'n8n_get_workflow', description: 'Get full JSON of one n8n workflow by ID.', input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'n8n_update_workflow', description: 'PUT updated workflow JSON to n8n. Destructive — propose_action first if production-impacting.', input_schema: { type: 'object', properties: { id: { type: 'string' }, workflow: { type: 'object', description: 'Full workflow JSON (name, nodes, connections, settings)' } }, required: ['id', 'workflow'] } },
  { name: 'n8n_executions', description: 'List recent executions. Filters: status=error|success|waiting, limit=N, workflowId=X.', input_schema: { type: 'object', properties: { status: { type: 'string' }, limit: { type: 'integer' }, workflowId: { type: 'string' } } } },
  { name: 'telegram_send', description: 'Send message to Atif on Telegram chat 6501185066. Optional inline buttons.', input_schema: { type: 'object', properties: { text: { type: 'string' }, buttons: { type: 'array', description: 'Optional inline_keyboard rows: [[{text, callback_data},...]]' } }, required: ['text'] } },
  { name: 'propose_action', description: 'Send Atif a Telegram message with [Approve]/[Reject] buttons asking him to authorize a destructive action. Returns immediately with a proposal_id; you should then ASK the user (in your text response) to tap the button before you proceed. Do NOT call the actual write tool until he confirms.', input_schema: { type: 'object', properties: { summary: { type: 'string', description: '1-2 sentence description of what would happen if approved' }, action_type: { type: 'string' }, payload: { type: 'object' } }, required: ['summary', 'action_type', 'payload'] } },
  { name: 'fetch_handbook', description: 'Fetch the live system handbook — current list of every department, workflow, table, endpoint, recent events, open HR proposals, active alerts. CALL THIS FIRST whenever the user asks about system structure or current state.', input_schema: { type: 'object', properties: {} } },
  { name: 'delegate_to_dept', description: 'Delegate a task to a specific department. The dept reads its task queue on its next tick and executes. Use this instead of doing the work yourself when an existing dept owns the responsibility. Framework v1 depts (meta_health, campaign_director, data_control, watchdog, campaign_dept, data_specialist) are reachable too — but in practice they run as inline phases of the outreach pipeline; for one-off framework calls prefer crownkey_api with action=outreach-pipeline / ceo-campaign / framework-status.', input_schema: { type: 'object', properties: { dept: { type: 'string', enum: ['finance','sales','diagnostic','watchdog','hr','campaign','crm_bridge','reply_enricher','meta_health','campaign_director','data_control','campaign_dept','data_specialist'] }, task: { type: 'string', description: 'Imperative description, like \"investigate sender X failure rate\"' }, priority: { type: 'string', enum: ['low','normal','high'] }, payload: { type: 'object', description: 'Optional structured args' } }, required: ['dept', 'task'] } },
];

async function tool_bash({ command, timeout_s = 30 }) {
  const cmd = String(command || '').trim();
  if (!cmd) return { error: 'empty command' };
  if (BASH_FORBIDDEN_RE.test(cmd)) {
    return { error: 'command rejected: shell metacharacters (;, &, |, `, <, >, $(, newline) not allowed' };
  }
  const firstTok = cmd.split(/\s+/)[0];
  const bin = firstTok.includes('/') ? path.basename(firstTok) : firstTok;
  if (!BASH_ALLOWED_BINS.has(bin)) {
    return { error: `command rejected: '${bin}' not in allowlist. Allowed: ${[...BASH_ALLOWED_BINS].sort().join(', ')}` };
  }
  // Extra hardening for curl/wget: block file write flags + file:// URIs that would
  // bypass tool_write_file's SCRATCH_DIR restriction or tool_read_file's allowlist.
  if ((bin === 'curl' || bin === 'wget')) {
    if (BASH_FORBIDDEN_CURL_FLAGS_RE.test(cmd)) {
      return { error: `command rejected: ${bin} write/upload flags (-o/-O/-T/--upload-file/--config) are blocked. Use tool_write_file for file output.` };
    }
    if (BASH_FORBIDDEN_URI_RE.test(cmd)) {
      return { error: `command rejected: file:// URIs not allowed. Use tool_read_file for local files.` };
    }
  }
  const timeoutMs = Math.min((timeout_s || 30) * 1000, 120_000);
  try {
    const { stdout, stderr } = await execAsync(cmd, { timeout: timeoutMs, maxBuffer: 1024 * 1024 * 4 });
    return { stdout: stdout.slice(-8000), stderr: stderr.slice(-2000) };
  } catch (e) {
    return { error: String(e.message || e), stdout: (e.stdout || '').slice(-4000), stderr: (e.stderr || '').slice(-2000), exit_code: e.code };
  }
}

async function tool_read_file({ path: p }) {
  try {
    const resolved = path.resolve(String(p || ''));
    const inAllowedRoot = READ_ALLOWED_ROOTS.some(root => resolved === root.replace(/\/$/, '') || resolved.startsWith(root));
    if (!inAllowedRoot) {
      return { error: `path rejected: reads restricted to ${READ_ALLOWED_ROOTS.join(', ')}` };
    }
    if (READ_BLOCKED_RE.test(path.basename(resolved))) {
      return { error: 'path rejected: .env files are not readable' };
    }
    return { content: (await fs.readFile(resolved, 'utf-8')).slice(0, 60000), path: resolved };
  } catch (e) { return { error: String(e) }; }
}

async function tool_write_file({ path: p, content }) {
  try {
    const resolved = path.resolve(SCRATCH_DIR, String(p || ''));
    if (!resolved.startsWith(SCRATCH_DIR + path.sep) && resolved !== SCRATCH_DIR) {
      return { error: `path rejected: writes restricted to ${SCRATCH_DIR}/` };
    }
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, content, 'utf-8');
    return { ok: true, bytes: content.length, path: resolved };
  } catch (e) { return { error: String(e) }; }
}

async function tool_web_fetch({ url, method = 'GET', headers = {}, body = null }) {
  try {
    const r = await fetchT(url, { method, headers, body });
    const text = await r.text();
    return { status: r.status, ok: r.ok, body: text.slice(0, 30000), content_type: r.headers.get('content-type') };
  } catch (e) { return { error: String(e) }; }
}

async function tool_crownkey_stats(input) {
  const params = new URLSearchParams(input);
  const r = await fetchT(`${CK_STATS_URL}?${params}`, { headers: ckHeaders() });
  return r.json();
}

async function tool_crownkey_api({ action, params = {}, method = 'GET', body = null }) {
  try {
    const qp = new URLSearchParams({ action, ...(params || {}) });
    const opts = { method, headers: ckHeaders() };
    if (method !== 'GET' && body !== null && body !== undefined) {
      opts.headers = { ...opts.headers, 'content-type': 'application/json' };
      opts.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const r = await fetchT(`${CK_BASE}?${qp}`, opts);
    const text = await r.text();
    try { return { status: r.status, body: JSON.parse(text) }; }
    catch { return { status: r.status, body: text.slice(0, 30000) }; }
  } catch (e) { return { error: String(e) }; }
}

async function tool_crownkey_send_message({ phone_with_country_code, template_name, language = 'en_US', header_image_url, sender_phone_id }) {
  const body = { phone_number: phone_with_country_code, template_name, template_language: language };
  if (header_image_url) body.header_image = header_image_url;
  if (sender_phone_id) body.from_phone_number_id = sender_phone_id;
  const r = await fetchT(CK_SEND_API, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${CK_TOKEN}` },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, response: text.slice(0, 4000) };
}

async function tool_n8n_list_workflows({ active_only = false } = {}) {
  const url = `${N8N_URL}/api/v1/workflows?limit=100${active_only ? '&active=true' : ''}`;
  const r = await fetchT(url, { headers: { 'X-N8N-API-KEY': N8N_KEY } });
  const data = await r.json().catch(() => null);
  if (!data?.data) return { error: 'no workflow data', raw: data };
  return { count: data.data.length, workflows: data.data.map(w => ({ id: w.id, name: w.name, active: w.active })) };
}

async function tool_n8n_get_workflow({ id }) {
  const r = await fetchT(`${N8N_URL}/api/v1/workflows/${id}`, { headers: { 'X-N8N-API-KEY': N8N_KEY } });
  return r.json();
}

async function tool_n8n_update_workflow({ id, workflow }) {
  const r = await fetchT(`${N8N_URL}/api/v1/workflows/${id}`, {
    method: 'PUT',
    headers: { 'X-N8N-API-KEY': N8N_KEY, 'content-type': 'application/json' },
    body: JSON.stringify(workflow),
  });
  return { status: r.status, body: (await r.text()).slice(0, 4000) };
}

async function tool_n8n_executions({ status, limit = 20, workflowId } = {}) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (status) params.set('status', status);
  if (workflowId) params.set('workflowId', workflowId);
  const r = await fetchT(`${N8N_URL}/api/v1/executions?${params}`, { headers: { 'X-N8N-API-KEY': N8N_KEY } });
  const data = await r.json().catch(() => null);
  if (!data?.data) return { error: 'no execution data', raw: data };
  return { count: data.data.length, executions: data.data.map(e => ({ id: e.id, workflowId: e.workflowId, status: e.status, startedAt: e.startedAt, mode: e.mode })) };
}

async function tool_telegram_send({ text, buttons }) {
  const body = { chat_id: TG_CHAT, text };
  if (buttons) body.reply_markup = { inline_keyboard: buttons };
  const r = await fetchT(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, ok: r.ok };
}

async function tool_propose_action({ summary, action_type, payload }) {
  const proposalId = `pa-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  // Persist the proposal first via the n8n "Proposed Actions Manager" webhook.
  // Without this step, when Atif taps Approve/Reject, the lookup in n8n's "07
  // - Telegram PA" workflow returns nothing → "⚠️ Could not find proposed
  // action <id>". So save BEFORE sending the Telegram buttons; if save fails,
  // surface the error and don't bother with Telegram.
  try {
    const saveResp = await fetchT(`${N8N_URL}/webhook/save-proposed-action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action_id: proposalId,
        summary: String(summary || ''),
        action_type: String(action_type || ''),
        payload: payload || {},
        chat_id: TG_CHAT,
      }),
    });
    if (!saveResp.ok) {
      const errText = await saveResp.text().catch(() => '');
      return { error: `save-proposed-action returned HTTP ${saveResp.status}: ${errText.slice(0, 200)}. Action NOT proposed (Telegram suppressed to avoid orphaned approve buttons).` };
    }
  } catch (e) {
    return { error: `save-proposed-action unreachable: ${String(e.message || e)}. Action NOT proposed.` };
  }
  // Save confirmed. Now send the Telegram buttons.
  const text = `🤖 PA proposes:\n\n${summary}\n\nAction type: ${action_type}\nPayload: ${JSON.stringify(payload, null, 2).slice(0, 500)}\n\nApprove to proceed.`;
  const buttons = [[
    { text: '✅ Approve', callback_data: `act:apv:${proposalId}` },
    { text: '❌ Reject', callback_data: `act:rej:${proposalId}` },
  ]];
  await tool_telegram_send({ text, buttons });
  return { proposal_id: proposalId, sent: true, note: 'Proposal saved + Telegram buttons sent. Wait for Atif to tap a button before proceeding with the actual write tool.' };
}

async function tool_fetch_handbook() {
  try {
    const r = await fetchT(`${CK_BASE}?action=handbook`, { headers: ckHeaders() });
    const text = await r.text();
    return { status: r.status, body: text.slice(0, 30000) };
  } catch (e) { return { error: String(e) }; }
}

async function tool_delegate_to_dept({ dept, task, priority = 'normal', payload = {} }) {
  try {
    const r = await fetchT(`${CK_BASE}?action=delegate`, {
      method: 'POST',
      headers: { ...ckHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ dept, task, priority, payload, assigned_by: 'pa' }),
    });
    return await r.json();
  } catch (e) { return { error: String(e) }; }
}

const TOOL_HANDLERS = {
  bash: tool_bash,
  read_file: tool_read_file,
  write_file: tool_write_file,
  web_fetch: tool_web_fetch,
  crownkey_stats: tool_crownkey_stats,
  crownkey_api: tool_crownkey_api,
  crownkey_send_message: tool_crownkey_send_message,
  n8n_list_workflows: tool_n8n_list_workflows,
  n8n_get_workflow: tool_n8n_get_workflow,
  n8n_update_workflow: tool_n8n_update_workflow,
  n8n_executions: tool_n8n_executions,
  telegram_send: tool_telegram_send,
  propose_action: tool_propose_action,
  fetch_handbook: tool_fetch_handbook,
  delegate_to_dept: tool_delegate_to_dept,
};

// Conversation history store with TTL + LRU cap so arbitrary conversation_id values
// from callers can't grow the Map unbounded. Map preserves insertion order, so to
// implement LRU we delete-then-set on every write (re-inserts to the tail).
const CONVERSATION_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const CONVERSATION_MAX = 500;
const conversations = new Map(); // id → { messages: [...], ts: epochMs }
const conversationChains = new Map();

function getConversationMessages(id) {
  const entry = conversations.get(id);
  if (!entry) return null;
  if (Date.now() - entry.ts > CONVERSATION_TTL_MS) {
    conversations.delete(id);
    return null;
  }
  // Refresh LRU position on read.
  conversations.delete(id);
  conversations.set(id, entry);
  return entry.messages;
}

function setConversationMessages(id, messages) {
  conversations.delete(id); // ensure re-insertion places this at the LRU tail
  conversations.set(id, { messages, ts: Date.now() });
  while (conversations.size > CONVERSATION_MAX) {
    const oldest = conversations.keys().next().value;
    if (oldest === undefined) break;
    conversations.delete(oldest);
  }
}

// Serialize concurrent /agent calls that share a conversation_id. Without this, two
// requests interleave their pushes into the messages array and corrupt the
// tool_use/tool_result pairing that the Anthropic API requires.
function withConversationLock(id, fn) {
  const prev = conversationChains.get(id) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => fn());
  conversationChains.set(id, next);
  next.finally(() => {
    if (conversationChains.get(id) === next) conversationChains.delete(id);
  }).catch(() => {});
  return next;
}

export async function runAgent(args) {
  const id = (args && args.conversation_id) || 'default';
  return withConversationLock(id, () => runAgentInner(args));
}

const ANTHROPIC_CALL_TIMEOUT_MS = 60_000;

async function runAgentInner({ message, conversation_id = 'default', max_iterations = 12, abortSignal = null }) {
  // Copy-on-read: work on a local array so a mid-run failure (or future concurrent
  // path) never mutates the persisted history. Only commit back on successful end_turn.
  const messages = [...(getConversationMessages(conversation_id) || [])];
  messages.push({ role: 'user', content: message });

  const trace = [];
  let iter = 0;
  while (iter < max_iterations) {
    iter++;
    if (abortSignal && abortSignal.aborted) {
      return { error: 'request aborted', iterations: iter, trace };
    }
    // Per-iteration controller: a 60s budget for the Anthropic call, plus a forward of
    // the caller's abort (if any — server.js wires this to req close so a client
    // disconnect cancels the outstanding Anthropic call instead of running it to completion).
    const iterCtl = new AbortController();
    const iterTimeout = setTimeout(() => iterCtl.abort('anthropic_timeout'), ANTHROPIC_CALL_TIMEOUT_MS);
    const forwardAbort = () => iterCtl.abort('caller_aborted');
    if (abortSignal) abortSignal.addEventListener('abort', forwardAbort, { once: true });
    let response;
    try {
      response = await claude.messages.create({
        model: 'claude-opus-4-7',
        max_tokens: 4096,
        system: SYSTEM,
        tools: TOOLS,
        messages,
      }, { signal: iterCtl.signal });
    } catch (e) {
      return { error: String(e.message || e), iterations: iter, trace };
    } finally {
      clearTimeout(iterTimeout);
      if (abortSignal) abortSignal.removeEventListener('abort', forwardAbort);
    }

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') {
      setConversationMessages(conversation_id, messages.slice(-30));
      const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
      return { answer: text, iterations: iter, trace };
    }

    if (response.stop_reason === 'tool_use') {
      const toolUses = response.content.filter(b => b.type === 'tool_use');
      const toolResults = [];
      for (const tu of toolUses) {
        const handler = TOOL_HANDLERS[tu.name];
        let result;
        try {
          result = handler ? await handler(tu.input) : { error: `unknown tool: ${tu.name}` };
        } catch (e) {
          result = { error: String(e.message || e) };
        }
        const summary = JSON.stringify(result).slice(0, 300);
        // Concise per-tool log so we can debug "Hit max iterations" failures from
        // Railway logs without needing to dig into commander_log every time.
        const inputBrief = JSON.stringify(tu.input || {}).slice(0, 200);
        console.log(new Date().toISOString(), `agent tool conv=${conversation_id} iter=${iter} ${tu.name}(${inputBrief}) → ${summary.slice(0, 240)}`);
        trace.push({ tool: tu.name, input: tu.input, result_preview: summary });
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result).slice(0, 30000) });
      }
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    return { answer: '(unexpected stop_reason: ' + response.stop_reason + ')', iterations: iter, trace };
  }

  return { answer: 'Hit max iterations without resolution.', iterations: iter, trace };
}
