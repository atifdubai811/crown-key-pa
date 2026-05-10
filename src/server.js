// Crown Key PA — always-on cloud brain (Claude Agent SDK)
import express from 'express';
import cors from 'cors';
import { runAgent } from './agent.js';

const PORT = parseInt(process.env.PORT || '8080', 10);

const CK_TOKEN = process.env.CROWNKEY_TOKEN || '';
const CK_STATS_URL = process.env.CK_STATS_URL || 'https://crownkey.online/n8n-stats.php';
const N8N_URL = process.env.N8N_URL || 'https://n8n.crownkeyuae.com';
const N8N_KEY = process.env.N8N_KEY || '';
const SB_URL = process.env.SUPABASE_URL || 'https://irsmzcrjffbvsflwhwpc.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '6501185066';
const PA_API_TOKEN = process.env.PA_API_TOKEN || '';

const ALLOWED_ORIGINS = new Set([
  'https://crownkey.online',
  'https://www.crownkey.online',
]);

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.has(origin)) return cb(null, true);
    return cb(new Error('origin not allowed'));
  },
  credentials: false,
}));

const log = (...a) => console.log(new Date().toISOString(), ...a);
const safeJson = async (res) => { try { return await res.json(); } catch { return null; } };

// All upstream HTTP calls go through this — never block a request on a hung backend.
const DEFAULT_FETCH_TIMEOUT_MS = 15000;
async function fetchT(url, init = {}, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: init.signal || ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

// Last-line safety nets. unhandledRejection is logged and absorbed (single rejected fetch
// shouldn't kill the brain). uncaughtException IS fatal — log, then exit so Railway's
// supervisor gives us a fresh process instead of letting a corrupted runtime soldier on.
process.on('unhandledRejection', (reason) => log('unhandledRejection:', reason && (reason.stack || reason.message || reason)));
process.on('uncaughtException', (err) => {
  log('uncaughtException — exiting for supervisor restart:', err && (err.stack || err.message || err));
  // Brief grace period for the log to flush, then exit non-zero so supervisor retries.
  setTimeout(() => process.exit(1), 250).unref();
});

function requireAuth(req, res, next) {
  if (!PA_API_TOKEN) return res.status(503).json({ error: 'auth_not_configured' });
  const h = req.header('authorization') || '';
  const provided = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (provided !== PA_API_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  next();
}

const ckHeaders = () => ({ Authorization: `Bearer ${CK_TOKEN}` });

// --- Memory (Phase B, 2026-05-10) ---
// Auto-save persists every Telegram /agent turn into the Conversation Log sheet
// via Memory Manager (n8n workflow wzRiftvNy27jRnZQ, /webhook/save-conversation).
// Fire-and-forget: post-hook fires AFTER res.json() ships, so the user never
// waits on a sheet write. Skip rules + secret redaction live below.

const MEMORY_AUTOSAVE_DISABLED = process.env.MEMORY_AUTOSAVE_DISABLED === '1';
const MEMORY_SAVE_URL = `${N8N_URL}/webhook/save-conversation`;
const MEMORY_FORGET_URL = `${CK_STATS_URL}?action=memory-forget-last`;

// Tools whose successful invocation = "this turn took an action that should
// be flagged in the memory row, even if the user message looked passive."
// Used by maybeAutoSave to set had_action=true. Refresh as new write tools land.
const WRITE_TOOLS = new Set([
  'crownkey_send_message', 'telegram_send', 'propose_action',
  'n8n_update_workflow', 'delegate_to_dept',
  'save_memory',
  // Phase A commander tools — every one of these returns an action when not in dry_run
  'launch_campaign', 'pause_campaign', 'resume_campaign', 'rotate_template',
  'trigger_template_preview',
  'recovery_pause', 'recovery_resume', 'recovery_drain',
  'sender_disable', 'sender_enable', 'sender_rotate',
  'director_skip', 'director_approve_pending', 'director_set_threshold',
  'contact_blacklist', 'contact_whitelist', 'bulk_blacklist_from_filter',
  'pause_dept', 'resume_dept',
  'system_freeze', 'system_unfreeze', 'emergency_stop_all_campaigns',
  'confirm_commander_action',
]);
const isWriteTool = (n) => WRITE_TOOLS.has(n);

// Strip credential leaks BEFORE we hand text to the sheet. Phones, AED amounts,
// and lead names are intentionally NOT redacted (per locked spec Section 6.1) —
// they ARE the operational data we want to recall.
function redactSecrets(s) {
  if (!s) return s;
  return String(s)
    .replace(/sk-ant-api03-[A-Za-z0-9_\-]+/g, 'sk-ant-***')
    .replace(/sk-[A-Za-z0-9]{20,}/g, 'sk-***')
    .replace(/eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g, 'eyJ***.***.***')
    .replace(/Bearer\s+[A-Za-z0-9_\-]{16,}/gi, 'Bearer ***');
}

async function maybeAutoSave({ message, result, conversation_id }) {
  try {
    if (MEMORY_AUTOSAVE_DISABLED) return;
    if (!result || result.error) return;
    if (typeof result.answer !== 'string' || !result.answer.length) return;
    if (message.trim().length < 3) return;
    if (/^\/forget(_last)?\b/i.test(message.trim())) return;
    if (result.answer.includes('memory_unreachable')) return; // don't loop on memory failure

    const userClean = redactSecrets(message);
    const replyClean = redactSecrets(result.answer);
    const hadAction = Array.isArray(result.trace)
      ? result.trace.some(t => isWriteTool(t.tool))
      : false;
    const hadImage = /\b(image|photo|render)\b/i.test((message || '') + ' ' + (result.answer || ''));

    const r = await fetchT(MEMORY_SAVE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: conversation_id,
        user_msg: userClean,
        assistant_msg: replyClean,
        tags: [],
        key_facts: [],
        iterations: result.iterations || 1,
        had_image: hadImage,
        had_action: hadAction,
        source: 'auto',
        channel: 'telegram',
      }),
    }, 8000);
    if (!r.ok) log(`memory autosave: HTTP ${r.status}`);
  } catch (e) {
    // NEVER throw — memory write failure must not crash the server or break the user reply
    log('memory autosave error:', String(e.message || e));
  }
}

async function memoryForgetLast({ conversation_id, count = 1 }) {
  try {
    const r = await fetchT(MEMORY_FORGET_URL, {
      method: 'POST',
      headers: { ...ckHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: conversation_id, count }),
    }, 8000);
    const data = await r.json().catch(() => null);
    return { ok: r.ok && (data?.ok !== false), marked: data?.marked ?? 0, raw: data };
  } catch (e) {
    return { ok: false, error: String(e.message || e), marked: 0 };
  }
}

// Public endpoints
app.get('/', (_req, res) => res.json({ service: 'crown-key-pa', version: '0.2.0', status: 'online', mode: 'agent' }));
app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString(), uptime_s: Math.floor(process.uptime()) }));

// Status — quick read of all systems
app.get('/status', requireAuth, async (_req, res) => {
  try {
    const [ckList, n8nWfs, dnrSys, dnrLanes] = await Promise.all([
      fetchT(`${CK_STATS_URL}?action=list`, { headers: ckHeaders() }).then(safeJson),
      fetchT(`${N8N_URL}/api/v1/workflows?limit=100`, { headers: { 'X-N8N-API-KEY': N8N_KEY } }).then(safeJson),
      fetchT(`${SB_URL}/rest/v1/system_state?id=eq.1&select=*`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }).then(safeJson),
      fetchT(`${SB_URL}/rest/v1/lanes?select=id,enabled`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }).then(safeJson),
    ]);
    const wfs = n8nWfs?.data || [];
    const sys = (Array.isArray(dnrSys) && dnrSys[0]) || {};
    res.json({
      ts: new Date().toISOString(),
      crownkey: { campaigns_total: (ckList?.campaigns || []).length, last_campaign: ckList?.campaigns?.[0] || null },
      n8n: { workflows_total: wfs.length, active: wfs.filter(w => w.active).length, names: wfs.filter(w => w.active).map(w => w.name) },
      dnr: { autonomous_mode: sys?.autonomous_mode ?? null, lanes_total: (dnrLanes || []).length, lanes_enabled: (dnrLanes || []).filter(l => l.enabled).length },
    });
  } catch (e) { log('/status error:', e); res.status(500).json({ error: 'upstream_failed' }); }
});

// Quick-read endpoints (no agent)
app.get('/campaigns', requireAuth, async (_req, res) => {
  try {
    const r = await fetchT(`${CK_STATS_URL}?action=list`, { headers: ckHeaders() }).then(safeJson);
    res.json(r || { error: 'crownkey_unreachable' });
  } catch (e) { log('/campaigns error:', e); res.status(502).json({ error: 'crownkey_unreachable' }); }
});
app.get('/campaigns/:uid', requireAuth, async (req, res) => {
  try {
    const r = await fetchT(`${CK_STATS_URL}?action=stats&uid=${encodeURIComponent(req.params.uid)}`, { headers: ckHeaders() }).then(safeJson);
    res.json(r || { error: 'crownkey_unreachable' });
  } catch (e) { log('/campaigns/:uid error:', e); res.status(502).json({ error: 'crownkey_unreachable' }); }
});
app.get('/campaigns/:uid/failed', requireAuth, async (req, res) => {
  try {
    const r = await fetchT(`${CK_STATS_URL}?action=failed&uid=${encodeURIComponent(req.params.uid)}`, { headers: ckHeaders() }).then(safeJson);
    res.json(r || { error: 'crownkey_unreachable' });
  } catch (e) { log('/campaigns/:uid/failed error:', e); res.status(502).json({ error: 'crownkey_unreachable' }); }
});

// Legacy chat — proxy to WF09 CEO Router (kept for backward compat)
app.post('/chat', requireAuth, async (req, res) => {
  const message = (req.body?.message || req.body?.text || '').toString().trim();
  if (!message) return res.status(400).json({ error: 'message required' });
  try {
    const r = await fetchT(`${N8N_URL}/webhook/ceo`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user_question: message }),
    });
    const data = await r.json().catch(() => null);
    res.json(data || { error: 'ceo_no_response' });
  } catch (e) { log('/chat error:', e); res.status(502).json({ error: 'ceo_unreachable' }); }
});

// REAL AGENT — full Claude Agent SDK with bash/web/n8n/crownkey/telegram tools
app.post('/agent', requireAuth, async (req, res) => {
  const message = (req.body?.message || req.body?.text || '').toString().trim();
  const conversation_id = (req.body?.conversation_id || 'default').toString();
  // Clamp to a safe range — caller can't drive runaway Anthropic spend or tool loops.
  const rawIters = parseInt(req.body?.max_iterations, 10);
  const max_iterations = Math.max(1, Math.min(12, Number.isFinite(rawIters) ? rawIters : 12));
  if (!message) return res.status(400).json({ error: 'message required' });
  // Log structurally instead of leaking message content (PII risk: phones, OTPs, names).
  log(`agent: req conv=${conversation_id} len=${message.length}`);

  // /forget_last and /forget intercept (Phase B). Handled here so Atlas never
  // sees the slash command — server fires the forget endpoint and returns a
  // fixed reply. Scope: current conversation_id only.
  const slashMatch = message.match(/^\/forget(_last)?\b\s*(\d+)?/i);
  if (slashMatch) {
    const count = slashMatch[1] ? 1 : Math.min(20, parseInt(slashMatch[2] || '5', 10) || 5);
    const r = await memoryForgetLast({ conversation_id, count });
    const reply = r.ok
      ? (r.marked > 0
          ? `Forgot the last ${r.marked === 1 ? 'exchange' : r.marked + ' exchanges'}. Anything else?`
          : `Nothing to forget — no recent saved turns in this conversation.`)
      : `Tried to forget but the memory store didn't respond. Try again in a moment.`;
    return res.json({ answer: reply, iterations: 0, trace: [{ tool: 'memory_forget', input: { count }, result: r }] });
  }

  // NOTE: previously wired req.on('close') → abortCtl.abort here as a "client
  // disconnect cancels Anthropic" optimization. That was wrong — Node fires
  // req 'close' as soon as the request body upload completes (PHP curl finishes
  // sending JSON body), aborting the agent on its very first iteration after
  // ~400ms. Per-iteration 60s AbortController timeout in agent.js already caps
  // runaway Anthropic spend; client-disconnect cancellation is not worth this
  // false-positive abort cost.
  try {
    const result = await runAgent({ message, conversation_id, max_iterations });
    if (!res.writableEnded) res.json(result);
    // Fire-and-forget memory autosave AFTER the response is shipped. Never
    // block the user reply on a sheet write; never throw out of this hook.
    queueMicrotask(() => maybeAutoSave({ message, result, conversation_id }));
  } catch (e) {
    log('agent error:', e);
    if (!res.writableEnded) res.status(500).json({ error: 'agent_failed' });
  }
});

// Watchdog
let lastWatchdogAt = null;
let watchdogState = { last_failures: 0, last_retried: 0, last_alerted: 0 };
let watchdogInFlight = false;
async function watchdogTick() {
  // Skip overlapping ticks. If a tick exceeds 5 min the next interval-fired tick must
  // not race with it — retry/alert decisions would be made twice on the same execution row.
  if (watchdogInFlight) { log('watchdog: skipped — previous tick still running'); return; }
  watchdogInFlight = true;
  lastWatchdogAt = new Date().toISOString();
  try {
    const r = await fetchT(`${N8N_URL}/api/v1/executions?status=error&limit=25`, { headers: { 'X-N8N-API-KEY': N8N_KEY } });
    const data = await r.json();
    const fails = data?.data || [];
    watchdogState.last_failures = fails.length;
    let retried = 0, alerted = 0;
    const fixablePatterns = [/quota|rate.?limit/i, /timeout/i, /econnreset|enotfound/i];
    const alertPatterns = [/401|403|unauthorized/i, /banned|forbidden/i];
    for (const exec of fails.slice(0, 5)) {
      const errMsg = exec.data?.resultData?.error?.message || exec.lastNodeExecuted || '';
      if (fixablePatterns.some(p => p.test(errMsg))) {
        await fetchT(`${N8N_URL}/api/v1/executions/${exec.id}/retry`, { method: 'POST', headers: { 'X-N8N-API-KEY': N8N_KEY } }).catch(() => {});
        retried++;
      } else if (alertPatterns.some(p => p.test(errMsg)) && TG_TOKEN) {
        await fetchT(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: TG_CHAT, text: `🚨 PA: workflow alert\n${exec.workflowData?.name || exec.workflowId}\nError: ${errMsg.slice(0, 200)}` }),
        }).catch(() => {});
        alerted++;
      }
    }
    watchdogState.last_retried = retried;
    watchdogState.last_alerted = alerted;
    if (fails.length > 0) log(`watchdog: ${fails.length} fails / ${retried} retried / ${alerted} alerted`);
  } catch (e) { log('watchdog error:', String(e)); }
  finally { watchdogInFlight = false; }
}
app.get('/watchdog', requireAuth, (_req, res) => res.json({ last_run: lastWatchdogAt, in_flight: watchdogInFlight, ...watchdogState }));
app.post('/watchdog/tick', requireAuth, async (_req, res) => {
  try { await watchdogTick(); res.json({ ok: true, last_run: lastWatchdogAt, ...watchdogState }); }
  catch (e) { log('/watchdog/tick error:', e); res.status(500).json({ error: 'watchdog_failed' }); }
});

app.listen(PORT, () => {
  log(`crown-key-pa v0.2 (agent mode) listening on :${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) log('WARN: ANTHROPIC_API_KEY missing — /agent disabled');
  if (process.env.WATCHDOG_DISABLED !== 'true') {
    setTimeout(() => { watchdogTick(); setInterval(watchdogTick, 5 * 60 * 1000); }, 30_000);
  }
});

process.on('SIGTERM', () => { log('SIGTERM — shutdown'); process.exit(0); });
