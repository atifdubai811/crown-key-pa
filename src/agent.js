// Claude Agent — full tool palette, autonomous PA
import Anthropic from '@anthropic-ai/sdk';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';

const execAsync = promisify(exec);
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const CK_TOKEN = process.env.CROWNKEY_TOKEN || '';
const CK_API_BASE = 'https://crownkey.online/api/a5696bc9-71b7-4421-a002-41863beac74b';
const CK_SEND_API = process.env.CK_SEND_API || `${CK_API_BASE}/contact/send-template-message`;
const CK_STATS_URL = process.env.CK_STATS_URL || 'https://crownkey.online/n8n-stats.php';
const N8N_URL = process.env.N8N_URL || 'https://n8n.crownkeyuae.com';
const N8N_KEY = process.env.N8N_KEY || '';
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '6501185066';

const HANDBOOK_URL = 'https://crownkey.online/n8n-stats.php?action=handbook&token=jdFQt9PzvjrY6iSZBsaoOUK3b82qcqDoe7s45TaYHzZp6UKC5WMd625CsSLfWWod';

const SYSTEM = `You are Atlas — Atif's autonomous AI co-pilot for Crown Key Real Estate Dubai. He's the founder. You're his thinking partner with full agentic control over the system.

⚠️ CRITICAL — READ THE LIVE HANDBOOK FIRST ⚠️
Before answering ANY structural question (what departments exist, what's running, what's failing, etc.), you MUST web_fetch the live handbook:
${HANDBOOK_URL}

The handbook is rebuilt fresh from MySQL + n8n API on every call. NEVER answer from memory about department lists, workflow IDs, or current state. Always fetch first. The system evolves daily — your assumptions WILL be stale.

The handbook contains: every department, every n8n workflow with current status, every MySQL table with row counts, every endpoint, recent dept_inbox events, open HR proposals, active alert states, today's metrics, user knobs.

CURRENT ECOSYSTEM (Nov 2026 baseline — verify via handbook for latest):
- 10 autonomous departments: Finance, Sales, Diagnostic, Watchdog, Lead Capture Watchdog, Watchdog Army (10 sub-monitors), Campaign, PA Aggregator, HR, Reply Enricher, CRM Bridge, WF01 Inbound.
- All depts write to dept_inbox MySQL table → PA Aggregator runs every 30 min → ONE conversational Telegram digest to user.
- Departments NEVER push to Telegram directly anymore.
- shouldNotify dedup helper means alerts only fire on STATE CHANGES, never on repeats.
- alert_state table tracks per-issue current state.
- commander_log table = persistent memory of every voice/chat exchange.
- Atif can delegate via voice: "Atlas, ask Finance to do X" → /n8n-stats.php?action=delegate creates a row in dept_tasks → that dept reads its queue on next tick + executes via Claude handler.

WHO YOU TALK TO: Atif (CEO/founder). Telegram chat 6501185066. WhatsApp 971558998452.

OPERATING RULES:
1. ALWAYS fetch the handbook before answering structural questions. NEVER claim a department doesn't exist without checking. Atif specifically corrected you on this — Finance, Sales, Diagnostic, HR, Watchdog Army etc. are all real.
2. READ-ONLY ops: do them freely.
3. WRITE/DESTRUCTIVE in production: propose_action first with approve/reject buttons.
4. DELEGATE rather than do-it-yourself when an existing dept owns the task. Use POST to /n8n-stats.php?action=delegate with {dept, task, priority, payload}. Then tell Atif "I asked X dept to handle that, they'll report back via PA digest."
5. Be conversational, not robotic. Use contractions. Vary sentence length. Don't read out lists — synthesize. NEVER use markdown asterisks (Telegram entity parser breaks on phones).
6. Voice mode: replies will be spoken — keep under ~50 words, plain sentences.
7. If a tool errors, investigate via bash/logs and fix. Don't just report.
8. Sign off naturally: "PA out." / "On it." / "Anything else?"

TONE: senior colleague who's been with him for years. Warm, smart, opinionated. Honest when something's broken or you don't know.`;

const TOOLS = [
  { name: 'bash', description: 'Execute a bash command on the PA server. Use for: git operations, curl with custom headers/data, system inspection, anything not covered by other tools. Runs in the /app directory of the Railway container.', input_schema: { type: 'object', properties: { command: { type: 'string' }, timeout_s: { type: 'number', description: 'Timeout in seconds (default 30, max 120)' } }, required: ['command'] } },
  { name: 'read_file', description: 'Read a file from the PA server (or via curl: pass URL).', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'write_file', description: 'Write content to a file on the PA server. For temporary/scratch use. Persistent state should go to sheets/DB.', input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'web_fetch', description: 'HTTP request to any URL with full control over method/headers/body. Returns response body + status.', input_schema: { type: 'object', properties: { url: { type: 'string' }, method: { type: 'string', enum: ['GET','POST','PUT','PATCH','DELETE'] }, headers: { type: 'object' }, body: { type: 'string', description: 'JSON-stringify the body if sending JSON' } }, required: ['url'] } },
  { name: 'crownkey_stats', description: 'Get CrownKey campaign data. action: list (all campaigns) | stats (one campaign details) | failed | delivered | read | sent.', input_schema: { type: 'object', properties: { action: { type: 'string', enum: ['list','stats','failed','delivered','read','sent','accepted'] }, uid: { type: 'string', description: 'Campaign UID (not needed for action=list)' }, template: { type: 'string' }, title: { type: 'string' }, limit: { type: 'integer' } }, required: ['action'] } },
  { name: 'crownkey_send_message', description: 'Send a WhatsApp template message via CrownKey API to ONE phone. Use for: test sends to Atifs number, single-recipient follow-ups. NEVER use for mass campaigns without proposing first.', input_schema: { type: 'object', properties: { phone_with_country_code: { type: 'string', description: 'e.g. 971558998452 (no + prefix)' }, template_name: { type: 'string' }, language: { type: 'string', description: 'e.g. en_US' }, header_image_url: { type: 'string' }, sender_phone_id: { type: 'string', description: 'WABA phone_id (one of the 3 Greens)' } }, required: ['phone_with_country_code', 'template_name'] } },
  { name: 'n8n_list_workflows', description: 'List all n8n workflows.', input_schema: { type: 'object', properties: { active_only: { type: 'boolean' } } } },
  { name: 'n8n_get_workflow', description: 'Get full JSON of one n8n workflow by ID.', input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'n8n_update_workflow', description: 'PUT updated workflow JSON to n8n. Destructive — propose_action first if production-impacting.', input_schema: { type: 'object', properties: { id: { type: 'string' }, workflow: { type: 'object', description: 'Full workflow JSON (name, nodes, connections, settings)' } }, required: ['id', 'workflow'] } },
  { name: 'n8n_executions', description: 'List recent executions. Filters: status=error|success|waiting, limit=N, workflowId=X.', input_schema: { type: 'object', properties: { status: { type: 'string' }, limit: { type: 'integer' }, workflowId: { type: 'string' } } } },
  { name: 'telegram_send', description: 'Send message to Atif on Telegram chat 6501185066. Optional inline buttons.', input_schema: { type: 'object', properties: { text: { type: 'string' }, buttons: { type: 'array', description: 'Optional inline_keyboard rows: [[{text, callback_data},...]]' } }, required: ['text'] } },
  { name: 'propose_action', description: 'Send Atif a Telegram message with [Approve]/[Reject] buttons asking him to authorize a destructive action. Returns immediately with a proposal_id; you should then ASK the user (in your text response) to tap the button before you proceed. Do NOT call the actual write tool until he confirms.', input_schema: { type: 'object', properties: { summary: { type: 'string', description: '1-2 sentence description of what would happen if approved' }, action_type: { type: 'string' }, payload: { type: 'object' } }, required: ['summary', 'action_type', 'payload'] } },
  { name: 'fetch_handbook', description: 'Fetch the live system handbook — current list of every department, workflow, table, endpoint, recent events, open HR proposals, active alerts. CALL THIS FIRST whenever the user asks about system structure or current state.', input_schema: { type: 'object', properties: {} } },
  { name: 'delegate_to_dept', description: 'Delegate a task to a specific department. The dept reads its task queue on its next tick and executes. Use this instead of doing the work yourself when an existing dept owns the responsibility.', input_schema: { type: 'object', properties: { dept: { type: 'string', enum: ['finance','sales','diagnostic','watchdog','hr','campaign','crm_bridge','reply_enricher'] }, task: { type: 'string', description: 'Imperative description, like \"investigate sender X failure rate\"' }, priority: { type: 'string', enum: ['low','normal','high'] }, payload: { type: 'object', description: 'Optional structured args' } }, required: ['dept', 'task'] } },
];

async function tool_bash({ command, timeout_s = 30 }) {
  const timeoutMs = Math.min((timeout_s || 30) * 1000, 120_000);
  try {
    const { stdout, stderr } = await execAsync(command, { timeout: timeoutMs, maxBuffer: 1024 * 1024 * 4 });
    return { stdout: stdout.slice(-8000), stderr: stderr.slice(-2000) };
  } catch (e) {
    return { error: String(e.message || e), stdout: (e.stdout || '').slice(-4000), stderr: (e.stderr || '').slice(-2000), exit_code: e.code };
  }
}

async function tool_read_file({ path }) {
  try { return { content: (await fs.readFile(path, 'utf-8')).slice(0, 60000) }; }
  catch (e) { return { error: String(e) }; }
}

async function tool_write_file({ path, content }) {
  try { await fs.writeFile(path, content, 'utf-8'); return { ok: true, bytes: content.length }; }
  catch (e) { return { error: String(e) }; }
}

async function tool_web_fetch({ url, method = 'GET', headers = {}, body = null }) {
  try {
    const r = await fetch(url, { method, headers, body });
    const text = await r.text();
    return { status: r.status, ok: r.ok, body: text.slice(0, 30000), content_type: r.headers.get('content-type') };
  } catch (e) { return { error: String(e) }; }
}

async function tool_crownkey_stats(input) {
  const params = new URLSearchParams({ token: CK_TOKEN, ...input });
  const url = `${CK_STATS_URL}?${params}`;
  const r = await fetch(url);
  return r.json();
}

async function tool_crownkey_send_message({ phone_with_country_code, template_name, language = 'en_US', header_image_url, sender_phone_id }) {
  const body = { phone_number: phone_with_country_code, template_name, template_language: language };
  if (header_image_url) body.header_image = header_image_url;
  if (sender_phone_id) body.from_phone_number_id = sender_phone_id;
  const r = await fetch(CK_SEND_API, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${CK_TOKEN}` },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, response: text.slice(0, 4000) };
}

async function tool_n8n_list_workflows({ active_only = false } = {}) {
  const url = `${N8N_URL}/api/v1/workflows?limit=100${active_only ? '&active=true' : ''}`;
  const r = await fetch(url, { headers: { 'X-N8N-API-KEY': N8N_KEY } });
  const data = await r.json().catch(() => null);
  if (!data?.data) return { error: 'no workflow data', raw: data };
  return { count: data.data.length, workflows: data.data.map(w => ({ id: w.id, name: w.name, active: w.active })) };
}

async function tool_n8n_get_workflow({ id }) {
  const r = await fetch(`${N8N_URL}/api/v1/workflows/${id}`, { headers: { 'X-N8N-API-KEY': N8N_KEY } });
  return r.json();
}

async function tool_n8n_update_workflow({ id, workflow }) {
  const r = await fetch(`${N8N_URL}/api/v1/workflows/${id}`, {
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
  const r = await fetch(`${N8N_URL}/api/v1/executions?${params}`, { headers: { 'X-N8N-API-KEY': N8N_KEY } });
  const data = await r.json().catch(() => null);
  if (!data?.data) return { error: 'no execution data', raw: data };
  return { count: data.data.length, executions: data.data.map(e => ({ id: e.id, workflowId: e.workflowId, status: e.status, startedAt: e.startedAt, mode: e.mode })) };
}

async function tool_telegram_send({ text, buttons }) {
  const body = { chat_id: TG_CHAT, text };
  if (buttons) body.reply_markup = { inline_keyboard: buttons };
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, ok: r.ok };
}

async function tool_propose_action({ summary, action_type, payload }) {
  const proposalId = `pa-${Date.now().toString(36)}`;
  const text = `🤖 PA proposes:\n\n${summary}\n\nAction type: ${action_type}\nPayload: ${JSON.stringify(payload, null, 2).slice(0, 500)}\n\nApprove to proceed.`;
  const buttons = [[
    { text: '✅ Approve', callback_data: `act:apv:${proposalId}` },
    { text: '❌ Reject', callback_data: `act:rej:${proposalId}` },
  ]];
  await tool_telegram_send({ text, buttons });
  return { proposal_id: proposalId, sent: true, note: 'Telegram message sent. Wait for Atif to tap a button before proceeding with the actual write tool.' };
}

async function tool_fetch_handbook() {
  try {
    const r = await fetch(HANDBOOK_URL);
    const text = await r.text();
    return { status: r.status, body: text.slice(0, 30000) };
  } catch (e) { return { error: String(e) }; }
}

async function tool_delegate_to_dept({ dept, task, priority = 'normal', payload = {} }) {
  try {
    const r = await fetch(HANDBOOK_URL.replace('action=handbook', 'action=delegate').replace('&format=html',''), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
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

const conversations = new Map();

export async function runAgent({ message, conversation_id = 'default', max_iterations = 12 }) {
  const messages = conversations.get(conversation_id) || [];
  messages.push({ role: 'user', content: message });

  const trace = [];
  let iter = 0;
  while (iter < max_iterations) {
    iter++;
    let response;
    try {
      response = await claude.messages.create({
        model: 'claude-opus-4-7',
        max_tokens: 4096,
        system: SYSTEM,
        tools: TOOLS,
        messages,
      });
    } catch (e) {
      return { error: String(e.message || e), iterations: iter, trace };
    }

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') {
      conversations.set(conversation_id, messages.slice(-30));
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
