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

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(cors({ origin: '*' }));

const log = (...a) => console.log(new Date().toISOString(), ...a);
const safeJson = async (res) => { try { return await res.json(); } catch { return null; } };

function requireAuth(req, res, next) {
  if (!PA_API_TOKEN) return next();
  const h = req.header('authorization') || '';
  const provided = h.startsWith('Bearer ') ? h.slice(7) : (req.query.token || '');
  if (provided !== PA_API_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// Public endpoints
app.get('/', (_req, res) => res.json({ service: 'crown-key-pa', version: '0.2.0', status: 'online', mode: 'agent' }));
app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString(), uptime_s: Math.floor(process.uptime()) }));

// Status — quick read of all systems
app.get('/status', requireAuth, async (_req, res) => {
  try {
    const [ckList, n8nWfs, dnrSys, dnrLanes] = await Promise.all([
      fetch(`${CK_STATS_URL}?action=list&token=${CK_TOKEN}`).then(safeJson),
      fetch(`${N8N_URL}/api/v1/workflows?limit=100`, { headers: { 'X-N8N-API-KEY': N8N_KEY } }).then(safeJson),
      fetch(`${SB_URL}/rest/v1/system_state?id=eq.1&select=*`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }).then(safeJson),
      fetch(`${SB_URL}/rest/v1/lanes?select=id,enabled`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }).then(safeJson),
    ]);
    const wfs = n8nWfs?.data || [];
    const sys = (Array.isArray(dnrSys) && dnrSys[0]) || {};
    res.json({
      ts: new Date().toISOString(),
      crownkey: { campaigns_total: (ckList?.campaigns || []).length, last_campaign: ckList?.campaigns?.[0] || null },
      n8n: { workflows_total: wfs.length, active: wfs.filter(w => w.active).length, names: wfs.filter(w => w.active).map(w => w.name) },
      dnr: { autonomous_mode: sys?.autonomous_mode ?? null, lanes_total: (dnrLanes || []).length, lanes_enabled: (dnrLanes || []).filter(l => l.enabled).length },
    });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Quick-read endpoints (no agent)
app.get('/campaigns', requireAuth, async (_req, res) => {
  const r = await fetch(`${CK_STATS_URL}?action=list&token=${CK_TOKEN}`).then(safeJson);
  res.json(r || { error: 'crownkey_unreachable' });
});
app.get('/campaigns/:uid', requireAuth, async (req, res) => {
  const r = await fetch(`${CK_STATS_URL}?action=stats&uid=${encodeURIComponent(req.params.uid)}&token=${CK_TOKEN}`).then(safeJson);
  res.json(r || { error: 'crownkey_unreachable' });
});
app.get('/campaigns/:uid/failed', requireAuth, async (req, res) => {
  const r = await fetch(`${CK_STATS_URL}?action=failed&uid=${encodeURIComponent(req.params.uid)}&token=${CK_TOKEN}`).then(safeJson);
  res.json(r || { error: 'crownkey_unreachable' });
});

// Legacy chat — proxy to WF09 CEO Router (kept for backward compat)
app.post('/chat', requireAuth, async (req, res) => {
  const message = (req.body?.message || req.body?.text || '').toString().trim();
  if (!message) return res.status(400).json({ error: 'message required' });
  try {
    const r = await fetch(`${N8N_URL}/webhook/ceo`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user_question: message }),
    });
    const data = await r.json().catch(() => null);
    res.json(data || { error: 'ceo_no_response' });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// REAL AGENT — full Claude Agent SDK with bash/web/n8n/crownkey/telegram tools
app.post('/agent', requireAuth, async (req, res) => {
  const message = (req.body?.message || req.body?.text || '').toString().trim();
  const conversation_id = (req.body?.conversation_id || 'default').toString();
  const max_iterations = parseInt(req.body?.max_iterations || '12', 10);
  if (!message) return res.status(400).json({ error: 'message required' });
  log(`agent: msg="${message.slice(0, 80)}" conv=${conversation_id}`);
  try {
    const result = await runAgent({ message, conversation_id, max_iterations });
    res.json(result);
  } catch (e) {
    log('agent error:', e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Watchdog
let lastWatchdogAt = null;
let watchdogState = { last_failures: 0, last_retried: 0, last_alerted: 0 };
async function watchdogTick() {
  lastWatchdogAt = new Date().toISOString();
  try {
    const r = await fetch(`${N8N_URL}/api/v1/executions?status=error&limit=25`, { headers: { 'X-N8N-API-KEY': N8N_KEY } });
    const data = await r.json();
    const fails = data?.data || [];
    watchdogState.last_failures = fails.length;
    let retried = 0, alerted = 0;
    const fixablePatterns = [/quota|rate.?limit/i, /timeout/i, /econnreset|enotfound/i];
    const alertPatterns = [/401|403|unauthorized/i, /banned|forbidden/i];
    for (const exec of fails.slice(0, 5)) {
      const errMsg = exec.data?.resultData?.error?.message || exec.lastNodeExecuted || '';
      if (fixablePatterns.some(p => p.test(errMsg))) {
        await fetch(`${N8N_URL}/api/v1/executions/${exec.id}/retry`, { method: 'POST', headers: { 'X-N8N-API-KEY': N8N_KEY } }).catch(() => {});
        retried++;
      } else if (alertPatterns.some(p => p.test(errMsg)) && TG_TOKEN) {
        await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
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
}
app.get('/watchdog', requireAuth, (_req, res) => res.json({ last_run: lastWatchdogAt, ...watchdogState }));
app.post('/watchdog/tick', requireAuth, async (_req, res) => { await watchdogTick(); res.json({ ok: true, last_run: lastWatchdogAt, ...watchdogState }); });

app.listen(PORT, () => {
  log(`crown-key-pa v0.2 (agent mode) listening on :${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) log('WARN: ANTHROPIC_API_KEY missing — /agent disabled');
  if (process.env.WATCHDOG_DISABLED !== 'true') {
    setTimeout(() => { watchdogTick(); setInterval(watchdogTick, 5 * 60 * 1000); }, 30_000);
  }
});

process.on('SIGTERM', () => { log('SIGTERM — shutdown'); process.exit(0); });
