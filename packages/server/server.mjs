// Agentorum — server.mjs
// HTTP + WebSocket server: serves the GUI, manages participants, watches the chatlog.

import http        from 'node:http';
import fs          from 'node:fs';
import fsp         from 'node:fs/promises';
import crypto      from 'node:crypto';
import { spawn }   from 'node:child_process';
import path        from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// CLI arguments
// ---------------------------------------------------------------------------
const args    = process.argv.slice(2);
const getArg  = (name, def) => { const i = args.indexOf(`--${name}`); return i !== -1 && args[i+1] ? args[i+1] : def; };
const hasFlag = (name) => args.includes(`--${name}`);

const CLI_PORT      = parseInt(getArg('port', '3737'), 10);
const CLI_CHATLOG   = getArg('chatlog', null);
const CONFIG_PATH   = path.resolve(getArg('config', 'agentorum.config.json'));
const AUTO_OPEN     = hasFlag('open');

// ---------------------------------------------------------------------------
// Config schema & defaults
// ---------------------------------------------------------------------------
const COLOR_PALETTE = ['#2563eb','#16a34a','#9333ea','#ea580c','#0891b2','#db2777'];

const DEFAULT_CONFIG = {
  chatlog: 'chatlog.md',
  port: CLI_PORT,
  participants: [
    {
      id: 'HUMAN',
      name: 'Human',
      role: 'Facilitator',
      color: '#2563eb',
      type: 'human'
    },
    {
      id: 'AGENT-1',
      name: 'Agent 1',
      role: 'Participant',
      color: '#16a34a',
      type: 'agent',
      agent: 'claude',
      respondTo: ['HUMAN'],
      systemPrompt: ''
    },
    {
      id: 'AGENT-2',
      name: 'Agent 2',
      role: 'Participant',
      color: '#9333ea',
      type: 'agent',
      agent: 'claude',
      respondTo: ['HUMAN'],
      systemPrompt: ''
    }
  ],
  automationRules: []
};

let config = { ...DEFAULT_CONFIG };

async function loadConfig() {
  try {
    const raw = await fsp.readFile(CONFIG_PATH, 'utf8');
    config = { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    config = { ...DEFAULT_CONFIG };
  }
  // CLI flags override config file
  if (hasFlag('port'))    config.port    = CLI_PORT;
  if (CLI_CHATLOG)        config.chatlog = CLI_CHATLOG;
  // Resolve chatlog relative to config file's directory
  config.chatlog = path.resolve(path.dirname(CONFIG_PATH), config.chatlog);
}

async function saveConfig() {
  // Save chatlog relative to config file directory for portability
  const relative = path.relative(path.dirname(CONFIG_PATH), config.chatlog);
  const toSave = { ...config, chatlog: relative };
  await fsp.writeFile(CONFIG_PATH, JSON.stringify(toSave, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// Chatlog parsing
// Entry format:  ### YYYY-MM-DD HH:MM:SS - PARTICIPANT_ID
//                [optional metadata lines starting with @]
//                body text (Markdown)
// ---------------------------------------------------------------------------
const ENTRY_RE = /^###\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s+-\s+(\S+)\s*$/gm;
const META_RE  = /^@(\w+):\s*(.+)$/;

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex').slice(0, 16);
}

function parseEntries(content) {
  const normalized = content.replace(/\r\n/g, '\n');
  const entries = [];
  const matches = [];
  ENTRY_RE.lastIndex = 0;
  let m;
  while ((m = ENTRY_RE.exec(normalized)) !== null) {
    matches.push({ ts: m[1], author: m[2], headerEnd: ENTRY_RE.lastIndex });
  }
  for (let i = 0; i < matches.length; i++) {
    const { ts, author, headerEnd } = matches[i];
    const nextHeaderStart = i + 1 < matches.length
      ? normalized.lastIndexOf('\n###', matches[i+1].headerEnd - 10)
      : normalized.length;
    const raw = normalized.slice(headerEnd, nextHeaderStart).trim();

    // Extract optional @key: value metadata lines from the top of the body
    const lines = raw.split('\n');
    const meta = {};
    let bodyStart = 0;
    for (let j = 0; j < lines.length; j++) {
      const metaMatch = lines[j].match(META_RE);
      if (metaMatch) {
        meta[metaMatch[1]] = metaMatch[2].trim();
        bodyStart = j + 1;
      } else {
        break;
      }
    }
    const body = lines.slice(bodyStart).join('\n').trim();

    entries.push({
      id:        sha256(`${ts}:${author}`),
      timestamp: ts,
      author,
      body,
      meta       // e.g. { replyTo: 'abc123', stance: 'bull' }
    });
  }
  return entries;
}

function formatEntry(participantId, body, meta = {}) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const metaLines = Object.entries(meta).map(([k, v]) => `@${k}: ${v}`).join('\n');
  const metaBlock = metaLines ? metaLines + '\n' : '';
  return `\n### ${ts} - ${participantId}\n\n${metaBlock}${body}\n`;
}

// ---------------------------------------------------------------------------
// Chatlog watcher
// ---------------------------------------------------------------------------
let _lastEntries  = [];
let _debounceTimer = null;
const DEBOUNCE_MS  = 600;

function startChatlogWatcher() {
  const chatlogPath = config.chatlog;
  if (!fs.existsSync(chatlogPath)) {
    fs.mkdirSync(path.dirname(chatlogPath), { recursive: true });
    fs.writeFileSync(chatlogPath, '', 'utf8');
  }
  fs.watch(chatlogPath, { persistent: true }, () => {
    clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(processChatlogChange, DEBOUNCE_MS);
  });
  processChatlogChange();
}

async function processChatlogChange() {
  try {
    const raw     = await fsp.readFile(config.chatlog, 'utf8');
    const entries = parseEntries(raw);
    const known   = new Set(_lastEntries.map(e => e.id));
    const fresh   = entries.filter(e => !known.has(e.id));
    _lastEntries  = entries;
    if (fresh.length > 0) {
      broadcast({ type: 'entries_added', entries: fresh });
      for (const entry of fresh) evaluateRules(entry);
    }
  } catch (err) {
    console.error('[watcher]', err.message);
  }
}

// ---------------------------------------------------------------------------
// Participant / agent manager
// ---------------------------------------------------------------------------
const agentProcs = new Map(); // participantId → { process, status, pid, logs, lastResponseAt }

function getAgentStatus(id) {
  const a = agentProcs.get(id);
  if (!a) return { id, status: 'stopped', pid: null, lastResponseAt: null, logs: [] };
  return { id, status: a.status, pid: a.pid, lastResponseAt: a.lastResponseAt, logs: a.logs.slice(-50) };
}

function startAgent(participant) {
  const { id } = participant;
  if (agentProcs.has(id) && agentProcs.get(id).status === 'running') return;

  const watcherPath = path.resolve(__dirname, '../watcher/watch.mjs');
  const respondTo   = (participant.respondTo || []).join(',');

  const proc = spawn('node', [
    watcherPath,
    '--participant-id', id,
    '--agent',          participant.agent || 'claude',
    '--respond-to',     respondTo,
    '--chatlog',        config.chatlog,
    '--config',         CONFIG_PATH,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  const state = { process: proc, status: 'running', pid: proc.pid, logs: [], lastResponseAt: null };
  agentProcs.set(id, state);

  const onData = (src) => (chunk) => {
    const line = chunk.toString().trim();
    if (!line) return;
    state.logs.push(`[${src}] ${line}`);
    if (state.logs.length > 500) state.logs.shift();
    if (line.includes('Response written')) {
      state.lastResponseAt = new Date().toISOString();
      broadcastAgentStatus(id);
    }
    broadcast({ type: 'agent_log', agentId: id, line: `[${src}] ${line}` });
  };

  proc.stdout.on('data', onData('out'));
  proc.stderr.on('data', onData('err'));
  proc.on('close', (code) => {
    state.status = 'stopped';
    state.pid    = null;
    broadcast({ type: 'agent_log', agentId: id, line: `[sys] exited (code ${code})` });
    broadcastAgentStatus(id);
  });

  broadcastAgentStatus(id);
}

function stopAgent(id) {
  const a = agentProcs.get(id);
  if (a?.status === 'running') a.process.kill('SIGTERM');
}

async function triggerAgent(participant) {
  const raw    = await fsp.readFile(config.chatlog, 'utf8').catch(() => '');
  const prompt = buildPrompt(participant, raw);

  const agentCmd = (participant.agent || 'claude').toLowerCase();
  const [cmd, cmdArgs] = agentCmd === 'codex'
    ? ['codex', ['--full-auto']]
    : ['claude', ['--print']];

  return new Promise((resolve) => {
    const proc = spawn(cmd, cmdArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
    proc.stdin.write(prompt);
    proc.stdin.end();
    let stdout = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.on('close', async () => {
      const response = stdout.trim();
      if (response && response !== 'NO_RESPONSE_NEEDED') {
        const entry = formatEntry(participant.id, response);
        await fsp.appendFile(config.chatlog, entry, 'utf8');
      }
      resolve(response);
    });
  });
}

function buildPrompt(participant, chatlogContent) {
  const sys = participant.systemPrompt?.trim()
    || `You are ${participant.id} (${participant.name}), playing the role of "${participant.role}" in a structured multi-agent debate.`;

  return `${sys}

CHATLOG:
${chatlogContent}

---
Task: Read the chatlog above. Decide whether ${participant.id} should write a response to the most recent entry.

- If a response IS needed: write ONLY the response body. Do not include the header line — it is added automatically.
- If no response is needed: output exactly this token and nothing else: NO_RESPONSE_NEEDED
`;
}

function broadcastAgentStatus(id) {
  broadcast({ type: 'agent_status', agent: getAgentStatus(id) });
}

// ---------------------------------------------------------------------------
// Automation rules
// ---------------------------------------------------------------------------
function evaluateRules(entry) {
  for (const rule of (config.automationRules || [])) {
    if (!rule.enabled) continue;
    if (rule.trigger?.type === 'entry_from' && rule.trigger?.author === entry.author) {
      const participant = config.participants.find(p => p.id === rule.action?.agentId);
      if (participant) {
        setTimeout(() => triggerAgent(participant), rule.action?.delayMs ?? 0);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// WebSocket broadcast
// ---------------------------------------------------------------------------
const clients = new Set();

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(data);
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function serveFile(res, filePath) {
  const ext  = path.extname(filePath);
  const mime = MIME[ext] || 'text/plain';
  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
}

function jsonResp(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise(resolve => {
    let buf = '';
    req.on('data', c => { buf += c.toString(); });
    req.on('end', () => resolve(buf));
  });
}

// ---------------------------------------------------------------------------
// HTTP router
// ---------------------------------------------------------------------------
const CLIENT_DIR = path.join(__dirname, 'client');

async function handleRequest(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { method } = req;
  const pathname   = new URL(req.url, 'http://localhost').pathname;

  if (!pathname.startsWith('/api/')) {
    // Static files
    const filePath = pathname === '/'
      ? path.join(CLIENT_DIR, 'index.html')
      : path.join(CLIENT_DIR, pathname);
    if (!filePath.startsWith(CLIENT_DIR)) { res.writeHead(403); res.end(); return; }
    return serveFile(res, filePath);
  }

  // --- /api/entries ---
  if (pathname === '/api/entries' && method === 'GET') {
    const raw = await fsp.readFile(config.chatlog, 'utf8').catch(() => '');
    return jsonResp(res, parseEntries(raw));
  }
  if (pathname === '/api/entries' && method === 'POST') {
    const { author, body, meta } = JSON.parse(await readBody(req));
    await fsp.appendFile(config.chatlog, formatEntry(author, body, meta || {}), 'utf8');
    return jsonResp(res, { ok: true });
  }

  // --- /api/participants ---
  if (pathname === '/api/participants' && method === 'GET') {
    return jsonResp(res, config.participants.map(p => ({ ...p, ...getAgentStatus(p.id) })));
  }

  const pMatch = pathname.match(/^\/api\/participants\/([^/]+)\/(\w+)$/);
  if (pMatch) {
    const [, id, action] = pMatch;
    const participant = config.participants.find(p => p.id === id);
    if (!participant) return jsonResp(res, { error: 'not found' }, 404);
    if (action === 'start')   { startAgent(participant); return jsonResp(res, { ok: true }); }
    if (action === 'stop')    { stopAgent(id);           return jsonResp(res, { ok: true }); }
    if (action === 'trigger') { triggerAgent(participant); return jsonResp(res, { ok: true }); }
    if (action === 'logs')    { return jsonResp(res, getAgentStatus(id).logs); }
  }

  // --- /api/config ---
  if (pathname === '/api/config' && method === 'GET') return jsonResp(res, config);
  if (pathname === '/api/config' && method === 'PUT') {
    const updates = JSON.parse(await readBody(req));
    config = { ...config, ...updates };
    await saveConfig();
    broadcast({ type: 'config_updated', config });
    return jsonResp(res, { ok: true });
  }

  // --- /api/rules ---
  if (pathname === '/api/rules' && method === 'GET') return jsonResp(res, config.automationRules || []);
  if (pathname === '/api/rules' && method === 'POST') {
    const rule = JSON.parse(await readBody(req));
    rule.id = rule.id || crypto.randomUUID();
    config.automationRules = [...(config.automationRules || []), rule];
    await saveConfig();
    return jsonResp(res, rule);
  }
  const rMatch = pathname.match(/^\/api\/rules\/([^/]+)$/);
  if (rMatch) {
    const [, ruleId] = rMatch;
    if (method === 'PUT') {
      const updates = JSON.parse(await readBody(req));
      config.automationRules = config.automationRules.map(r => r.id === ruleId ? { ...r, ...updates } : r);
      await saveConfig();
      return jsonResp(res, { ok: true });
    }
    if (method === 'DELETE') {
      config.automationRules = config.automationRules.filter(r => r.id !== ruleId);
      await saveConfig();
      return jsonResp(res, { ok: true });
    }
  }

  jsonResp(res, { error: 'not found' }, 404);
}

// ---------------------------------------------------------------------------
// Server startup
// ---------------------------------------------------------------------------
async function main() {
  await loadConfig();

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch(err => {
      console.error(err);
      res.writeHead(500); res.end('Internal error');
    });
  });

  const wss = new WebSocketServer({ server });
  wss.on('connection', async (ws) => {
    clients.add(ws);
    // Send initial state
    const raw     = await fsp.readFile(config.chatlog, 'utf8').catch(() => '');
    const entries = parseEntries(raw);
    ws.send(JSON.stringify({ type: 'init', entries: entries.slice(-500), total: entries.length, config }));
    for (const p of config.participants.filter(p => p.type === 'agent')) {
      ws.send(JSON.stringify({ type: 'agent_status', agent: getAgentStatus(p.id) }));
    }
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });

  // Keepalive pings
  setInterval(() => {
    for (const ws of clients) {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, 30_000);

  const PORT = config.port || CLI_PORT;
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[agentorum] http://127.0.0.1:${PORT}`);
    console.log(`[agentorum] chatlog : ${config.chatlog}`);
    console.log(`[agentorum] config  : ${CONFIG_PATH}`);
    if (AUTO_OPEN) {
      const opener = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      spawn(opener, [`http://127.0.0.1:${PORT}`], { shell: true, detached: true, stdio: 'ignore' }).unref();
    }
  });

  startChatlogWatcher();
}

main().catch(err => { console.error(err); process.exit(1); });
