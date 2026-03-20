// Agentorum — server.mjs
// HTTP + WebSocket server: serves the GUI, manages participants, watches the chatlog.
//
// Can be run directly:  node server.mjs [--config path] [--port N] [--open]
//                       node server.mjs [--workspace dir] [--open]
// Or imported by Electron main.mjs:  import { startServer } from './server.mjs'

import http        from 'node:http';
import fs          from 'node:fs';
import fsp         from 'node:fs/promises';
import crypto      from 'node:crypto';
import { spawn }   from 'node:child_process';
import path        from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { WorkspaceManager } from './workspace.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// CLI arguments
// ---------------------------------------------------------------------------
const args    = process.argv.slice(2);
const getArg  = (name, def) => { const i = args.indexOf(`--${name}`); return i !== -1 && args[i+1] ? args[i+1] : def; };
const hasFlag = (name) => args.includes(`--${name}`);

const CLI_PORT      = parseInt(getArg('port', '3737'), 10);
const CLI_CHATLOG   = getArg('chatlog', null);
const CLI_WORKSPACE = getArg('workspace', null);
const CLI_BUNDLE    = getArg('bundle', null);
const AUTO_OPEN     = hasFlag('open');

// Determine mode: single-session (--config) vs workspace
const HAS_CONFIG    = args.includes('--config');
const CONFIG_PATH   = HAS_CONFIG
  ? path.resolve(getArg('config', 'agentorum.config.json'))
  : null;

// ---------------------------------------------------------------------------
// Workspace manager (workspace mode only)
// ---------------------------------------------------------------------------
let workspaceManager = null;

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

let config           = { ...DEFAULT_CONFIG };
let activeConfigPath = CONFIG_PATH;  // tracks the current config file path (mutable in workspace mode)
let activeSessionToken = null;       // session token for interactive agent validation

async function loadConfig(configFilePath) {
  const target = configFilePath || activeConfigPath;
  if (!target) {
    config = { ...DEFAULT_CONFIG };
    return;
  }
  try {
    const raw = await fsp.readFile(target, 'utf8');
    config = { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    config = { ...DEFAULT_CONFIG };
  }
  // CLI flags override config file
  if (hasFlag('port'))    config.port    = CLI_PORT;
  if (CLI_CHATLOG)        config.chatlog = CLI_CHATLOG;
  // Resolve chatlog relative to config file's directory
  if (target) {
    config.chatlog = path.resolve(path.dirname(target), config.chatlog);
  }
}

async function loadSessionToken() {
  if (!activeConfigPath) { activeSessionToken = null; return; }
  const sessionFile = path.join(path.dirname(activeConfigPath), 'session.json');
  try {
    const data = JSON.parse(await fsp.readFile(sessionFile, 'utf8'));
    activeSessionToken = data.token || null;
  } catch {
    activeSessionToken = null;
  }
}

async function saveConfig() {
  if (!activeConfigPath) return;
  // Save chatlog relative to config file directory for portability
  const relative = path.relative(path.dirname(activeConfigPath), config.chatlog);
  const toSave = { ...config, chatlog: relative };
  await fsp.writeFile(activeConfigPath, JSON.stringify(toSave, null, 2), 'utf8');
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
// Rating / scoring
// ---------------------------------------------------------------------------
const SCORE_EVENTS = {
  catch: 2, insight: 2, confirm: 1,
  error: -2, omission: -1, retract: -1, deflect: -1
};

function computeScores(entries) {
  // scores[participantId] = { total, events[] }
  const scores = {};
  for (const entry of entries) {
    if (entry.meta?.type !== 'rating') continue;
    const target = entry.meta?.target;
    if (!target) continue;
    const eventName = entry.meta?.event || '';
    const score     = parseInt(entry.meta?.score ?? SCORE_EVENTS[eventName] ?? 0, 10);
    if (!scores[target]) scores[target] = { total: 0, events: [] };
    scores[target].total += score;
    scores[target].events.push({
      ratingEntryId: entry.id,
      rater:         entry.author,
      event:         eventName,
      score,
      entryRef:      entry.meta?.entryRef || null,
      ts:            entry.timestamp,
      rationale:     entry.body || ''
    });
  }
  return scores;
}

// ---------------------------------------------------------------------------
// Chatlog watcher
// ---------------------------------------------------------------------------
let _lastEntries  = [];
let _debounceTimer = null;
let _watcherInstance = null;
const DEBOUNCE_MS  = 600;

function startChatlogWatcher() {
  const chatlogPath = config.chatlog;
  if (!chatlogPath) return;

  // Stop any existing watcher
  if (_watcherInstance) {
    try { _watcherInstance.close(); } catch { /* ignore */ }
    _watcherInstance = null;
  }

  if (!fs.existsSync(chatlogPath)) {
    fs.mkdirSync(path.dirname(chatlogPath), { recursive: true });
    fs.writeFileSync(chatlogPath, '', 'utf8');
  }
  _watcherInstance = fs.watch(chatlogPath, { persistent: true }, () => {
    clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(processChatlogChange, DEBOUNCE_MS);
  });
  _lastEntries = [];
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
      // Rebroadcast scores whenever a new rating entry arrives
      if (fresh.some(e => e.meta?.type === 'rating')) {
        broadcast({ type: 'scores_updated', scores: computeScores(entries) });
      }
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
  // Agent control modes:
  //   'interactive' — user runs their own CLI session (Claude Code, Codex, etc.)
  //                   and connects it via the copy-paste init command.
  //                   The server does NOT spawn a subprocess for these.
  //   'api'         — server calls the LLM provider API directly (future).
  //                   No subprocess; no init command needed.
  //   default       — server spawns and manages a CLI watcher subprocess.
  //
  // Only the default (watcher) mode reaches the spawn logic below.
  if (participant.mode === 'interactive') {
    console.log(`[agentorum] ${participant.id} is interactive — user manages this CLI session; no watcher spawned`);
    return;
  }
  if (participant.mode === 'api') {
    console.log(`[agentorum] ${participant.id} is api — direct API calls; no watcher spawned`);
    return;
  }
  const { id } = participant;
  if (agentProcs.has(id) && agentProcs.get(id).status === 'running') return;

  const watcherPath = path.resolve(__dirname, '../watcher/watch.mjs');
  const respondTo   = (participant.respondTo || []).join(',');

  // When running inside Electron there is no standalone 'node' binary —
  // process.execPath is the Electron binary, which can also run Node scripts.
  const nodeExe  = process.versions.electron ? process.execPath : 'node';

  const configArg = activeConfigPath || '';

  // rules.txt: explicit config.rules path wins, otherwise fall back to
  // rules.txt sitting next to the chatlog (the watcher also auto-discovers
  // this, but passing it explicitly makes the log output unambiguous).
  const rulesArg = config.rules
    ? path.resolve(path.dirname(activeConfigPath || config.chatlog), config.rules)
    : path.resolve(path.dirname(config.chatlog), 'rules.txt');

  const proc = spawn(nodeExe, [
    watcherPath,
    '--participant-id', id,
    '--agent',          participant.agent || 'claude',
    '--respond-to',     respondTo,
    '--chatlog',        config.chatlog,
    '--config',         configArg,
    '--rules',          rulesArg,
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

function stopAllAgents() {
  for (const [id] of agentProcs) {
    stopAgent(id);
  }
  agentProcs.clear();
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
// Returns true if this participant can be triggered via the watcher/subprocess path.
// 'interactive' agents run in the user's own terminal — the server must not spawn for them.
// 'api' agents use direct LLM API calls (future) — a different trigger path will handle them.
// Only the default watcher mode is eligible for subprocess-based triggering.
function isWatcherTriggerable(participant) {
  return participant.mode !== 'interactive' && participant.mode !== 'api';
}

function evaluateRules(entry) {
  for (const rule of (config.automationRules || [])) {
    if (!rule.enabled) continue;
    if (rule.trigger?.type === 'entry_from' && rule.trigger?.author === entry.author) {
      const participant = config.participants.find(p => p.id === rule.action?.agentId);
      if (participant && isWatcherTriggerable(participant)) {
        setTimeout(() => triggerAgent(participant), rule.action?.delayMs ?? 0);
      }
    }
    // every_5_entries rule: check total entry count
    if (rule.trigger?.type === 'every_5_entries') {
      const total = _lastEntries.length;
      if (total > 0 && total % 5 === 0) {
        const participant = config.participants.find(p => p.id === rule.action?.agentId);
        if (participant && isWatcherTriggerable(participant)) {
          setTimeout(() => triggerAgent(participant), rule.action?.delayMs ?? 0);
        }
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
const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.pdf': 'application/pdf'
};

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

  // -------------------------------------------------------------------------
  // Static file routing
  // -------------------------------------------------------------------------
  if (!pathname.startsWith('/api/')) {
    if (workspaceManager) {
      // Workspace mode: home screen at /, session view at /session
      if (pathname === '/') {
        return serveFile(res, path.join(CLIENT_DIR, 'home.html'));
      }
      if (pathname === '/session') {
        return serveFile(res, path.join(CLIENT_DIR, 'index.html'));
      }
    } else {
      // Single-session mode: index.html at /
      if (pathname === '/') {
        return serveFile(res, path.join(CLIENT_DIR, 'index.html'));
      }
    }

    // All other static assets (JS, CSS, etc.)
    const filePath = path.join(CLIENT_DIR, pathname);
    if (!filePath.startsWith(CLIENT_DIR)) { res.writeHead(403); res.end(); return; }
    return serveFile(res, filePath);
  }

  // -------------------------------------------------------------------------
  // Workspace-mode API routes
  // -------------------------------------------------------------------------
  if (workspaceManager) {
    // GET /api/workspace
    if (pathname === '/api/workspace' && method === 'GET') {
      try {
        return jsonResp(res, await workspaceManager.getWorkspaceInfo());
      } catch (err) {
        return jsonResp(res, { error: err.message }, 500);
      }
    }

    // GET /api/scenarios
    if (pathname === '/api/scenarios' && method === 'GET') {
      try {
        return jsonResp(res, await workspaceManager.listScenarios());
      } catch (err) {
        return jsonResp(res, { error: err.message }, 500);
      }
    }

    // GET /api/projects
    if (pathname === '/api/projects' && method === 'GET') {
      try {
        return jsonResp(res, await workspaceManager.listProjects());
      } catch (err) {
        return jsonResp(res, { error: err.message }, 500);
      }
    }

    // POST /api/projects
    if (pathname === '/api/projects' && method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req));
        const project = await workspaceManager.createProject(body);
        return jsonResp(res, project, 201);
      } catch (err) {
        return jsonResp(res, { error: err.message }, 400);
      }
    }

    // GET /api/projects/:projectId
    const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
    if (projectMatch && method === 'GET') {
      const [, projectId] = projectMatch;
      try {
        return jsonResp(res, await workspaceManager.getProject(projectId));
      } catch (err) {
        return jsonResp(res, { error: err.message }, 404);
      }
    }

    // GET /api/projects/:projectId/sessions
    const sessionsListMatch = pathname.match(/^\/api\/projects\/([^/]+)\/sessions$/);
    if (sessionsListMatch && method === 'GET') {
      const [, projectId] = sessionsListMatch;
      try {
        return jsonResp(res, await workspaceManager.listSessions(projectId));
      } catch (err) {
        return jsonResp(res, { error: err.message }, 404);
      }
    }

    // POST /api/projects/:projectId/sessions
    if (sessionsListMatch && method === 'POST') {
      const [, projectId] = sessionsListMatch;
      try {
        const body   = JSON.parse(await readBody(req));
        const result = await workspaceManager.createSession(projectId, body);
        return jsonResp(res, result, 201);
      } catch (err) {
        return jsonResp(res, { error: err.message }, 400);
      }
    }

    // POST /api/sessions/:projectId/:sessionId/open
    const openMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/([^/]+)\/open$/);
    if (openMatch && method === 'POST') {
      const [, projectId, sessionId] = openMatch;
      try {
        const session    = await workspaceManager.getSession(projectId, sessionId);
        const sessionDir = path.join(
          workspaceManager.projectsDir, projectId, 'sessions', sessionId
        );
        const configPath = path.join(sessionDir, 'agentorum.config.json');

        // Stop all currently running agents
        stopAllAgents();

        // Reload config from this session's config file
        activeConfigPath = configPath;
        await loadConfig(configPath);
        await loadSessionToken();

        // Restart chatlog watcher for new chatlog
        startChatlogWatcher();

        // Broadcast updated config to connected clients
        broadcast({ type: 'config_updated', config });

        // Update session lastActive
        await workspaceManager.updateSessionLastActive(projectId, sessionId);

        return jsonResp(res, { ok: true, redirectTo: '/session' });
      } catch (err) {
        return jsonResp(res, { error: err.message }, 500);
      }
    }

    // POST /api/bundles/load
    if (pathname === '/api/bundles/load' && method === 'POST') {
      try {
        const bundle = JSON.parse(await readBody(req));
        const result = await workspaceManager.loadBundleFromObject(bundle);
        const { projectId, sessionId, configPath } = result;

        // Activate the newly created session
        stopAllAgents();
        activeConfigPath = configPath;
        await loadConfig(configPath);
        await loadSessionToken();
        startChatlogWatcher();
        broadcast({ type: 'config_updated', config });
        await workspaceManager.updateSessionLastActive(projectId, sessionId);

        return jsonResp(res, { ok: true, projectId, sessionId, redirectTo: '/session' });
      } catch (err) {
        return jsonResp(res, { error: err.message }, 400);
      }
    }

    // GET /api/bundles/schema
    if (pathname === '/api/bundles/schema' && method === 'GET') {
      const schema = {
        bundleVersion: 1,
        id: 'your-bundle-id',
        name: 'Human-readable bundle name',
        description: 'What this bundle sets up',
        icon: '🔧',
        prerequisites: [
          'Node.js 18+',
          'Claude Code CLI (claude --version)'
        ],
        project: {
          name: 'Project name shown in the workspace',
          description: 'Optional project description'
        },
        scenario: {
          id: 'your-scenario-id',
          name: 'Scenario name',
          participants: [
            {
              id: 'HUMAN',
              label: 'Human label',
              color: '#555555',
              agent: 'human',
              stance: 'neutral'
            },
            {
              id: 'AGENT-1',
              label: 'Agent label',
              color: '#2563eb',
              agent: 'claude',
              stance: 'neutral',
              respondTo: ['HUMAN'],
              systemPrompt: 'System prompt for this agent.'
            }
          ],
          automationRules: [
            {
              id: 'rule-1',
              enabled: true,
              label: 'Rule label',
              trigger: { type: 'entry_from', author: 'HUMAN' },
              action: { type: 'trigger_agent', agentId: 'AGENT-1', delayMs: 3000 }
            }
          ]
        },
        sessionTemplate: {
          namePrefix: 'Session',
          initialEntry: {
            author: 'HUMAN',
            body: 'Opening message text shown in the chatlog when the session starts.'
          }
        }
      };
      return jsonResp(res, schema);
    }
  }

  // -------------------------------------------------------------------------
  // Session-mode API routes (available in both modes when a session is active)
  // -------------------------------------------------------------------------

  // --- /api/entries ---
  if (pathname === '/api/entries' && method === 'GET') {
    if (!config.chatlog) return jsonResp(res, []);
    const raw = await fsp.readFile(config.chatlog, 'utf8').catch(() => '');
    return jsonResp(res, parseEntries(raw));
  }
  if (pathname === '/api/entries' && method === 'POST') {
    const { author, body, meta } = JSON.parse(await readBody(req));
    // Soft token validation for interactive participants:
    // if a token header is present and wrong, reject; if absent, allow through (UI posts).
    if (activeSessionToken) {
      const participant = config.participants.find(p => p.id === author);
      if (participant?.mode === 'interactive') {
        const provided = req.headers['x-agentorum-token'];
        if (provided && provided !== activeSessionToken) {
          const sessionDir = activeConfigPath ? path.dirname(activeConfigPath) : '';
          return jsonResp(res, {
            error: 'invalid_token',
            message: `Session token incorrect. Re-initialise your agent: Read this file and confirm your role: ${path.join(sessionDir, `rules-${author}.txt`)}`
          }, 401);
        }
      }
    }
    await fsp.appendFile(config.chatlog, formatEntry(author, body, meta || {}), 'utf8');
    return jsonResp(res, { ok: true });
  }

  // --- /api/scores — computed scores from rating entries ---
  if (pathname === '/api/scores' && method === 'GET') {
    const raw     = await fsp.readFile(config.chatlog, 'utf8').catch(() => '');
    const entries = parseEntries(raw);
    return jsonResp(res, computeScores(entries));
  }

  // --- /api/scores/events — all valid rating event types and their point values ---
  if (pathname === '/api/scores/events' && method === 'GET') {
    return jsonResp(res, SCORE_EVENTS);
  }

  // --- /api/session — current session info and interactive agent init commands ---
  if (pathname === '/api/session' && method === 'GET') {
    if (!activeConfigPath) return jsonResp(res, { active: false });
    const sessionDir = path.dirname(activeConfigPath);
    const interactiveParticipants = (config.participants || [])
      .filter(p => p.mode === 'interactive')
      .map(p => {
        const rulesFile = path.join(sessionDir, `rules-${p.id}.txt`);
        return {
          id:          p.id,
          label:       p.label || p.name || p.id,
          color:       p.color,
          rulesFile,
          initCommand: `Read this file and confirm your role: ${rulesFile}`
        };
      });
    return jsonResp(res, { active: true, sessionDir, token: activeSessionToken, interactiveParticipants });
  }

  // --- /api/media/:filename — serve media files from session media folder ---
  const mediaServeMatch = pathname.match(/^\/api\/media\/(.+)$/);
  if (mediaServeMatch && method === 'GET') {
    if (!activeConfigPath) return jsonResp(res, { error: 'no active session' }, 404);
    const safeName = mediaServeMatch[1].replace(/\.\./g, '').replace(/^\/+/, '');
    const mediaDir  = path.join(path.dirname(activeConfigPath), 'media');
    const mediaPath = path.join(mediaDir, safeName);
    if (!mediaPath.startsWith(mediaDir)) { res.writeHead(403); res.end(); return; }
    return serveFile(res, mediaPath);
  }

  // --- /api/media/upload — save base64-encoded file to session media folder ---
  if (pathname === '/api/media/upload' && method === 'POST') {
    if (!activeConfigPath) return jsonResp(res, { error: 'no active session' }, 404);
    const { filename, data } = JSON.parse(await readBody(req));
    if (!filename || !data) return jsonResp(res, { error: 'missing filename or data' }, 400);
    const safeName  = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
    const mediaDir  = path.join(path.dirname(activeConfigPath), 'media');
    await fsp.mkdir(mediaDir, { recursive: true });
    const base64    = data.replace(/^data:[^;]+;base64,/, '');
    await fsp.writeFile(path.join(mediaDir, safeName), Buffer.from(base64, 'base64'));
    return jsonResp(res, { ok: true, filename: safeName, url: `/api/media/${safeName}` });
  }

  // --- /api/context/:participantId — role-aware context snippet for interactive agents ---
  const contextMatch = pathname.match(/^\/api\/context\/([^/]+)$/);
  if (contextMatch && method === 'GET') {
    const [, participantId] = contextMatch;
    const participant = config.participants.find(p => p.id === participantId);
    if (!participant) return jsonResp(res, { error: 'participant not found' }, 404);
    const sessionDir = activeConfigPath ? path.dirname(activeConfigPath) : path.dirname(config.chatlog);
    let summary = null;
    try { summary = await fsp.readFile(path.join(sessionDir, 'summary.md'), 'utf8'); } catch { /* none yet */ }
    const raw          = await fsp.readFile(config.chatlog, 'utf8').catch(() => '');
    const entries      = parseEntries(raw);
    const recentEntries = entries.slice(-50);
    return jsonResp(res, {
      authorId:      participantId,
      label:         participant.label || participant.name || participantId,
      role:          participant.systemPrompt || participant.role || '',
      summary,
      recentEntries,
      totalEntries:  entries.length,
      apiEndpoint:  `http://localhost:${config.port || 3737}/api/entries`,
      token:         activeSessionToken
    });
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

  // --- /api/reload  (used by Electron "Open Config" menu item) ---
  if (pathname === '/api/reload' && method === 'POST') {
    const { configPath } = JSON.parse(await readBody(req));
    if (configPath) {
      activeConfigPath = configPath;
      await loadConfig(configPath);
      startChatlogWatcher();
      broadcast({ type: 'config_updated', config });
    }
    return jsonResp(res, { ok: true });
  }

  jsonResp(res, { error: 'not found' }, 404);
}

// ---------------------------------------------------------------------------
// Server startup
// ---------------------------------------------------------------------------
async function main() {
  // Determine whether to run in workspace mode or single-session mode
  if (!HAS_CONFIG) {
    // Workspace mode
    const wsDir = CLI_WORKSPACE
      ? path.resolve(CLI_WORKSPACE)
      : null;  // WorkspaceManager will use default (~/.agentorum)

    workspaceManager = wsDir
      ? new WorkspaceManager(wsDir)
      : new WorkspaceManager();

    await workspaceManager.init();
    console.log(`[agentorum] workspace : ${workspaceManager.workspaceDir}`);

    // --bundle: load bundle file and activate the resulting session
    if (CLI_BUNDLE) {
      const bundlePath = path.resolve(CLI_BUNDLE);
      const result     = await workspaceManager.loadBundle(bundlePath);
      const { projectId, sessionId, configPath, sessionName } = result;

      activeConfigPath = configPath;
      await loadConfig(configPath);
      await loadSessionToken();

      console.log(`[agentorum] Bundle loaded: created project "${projectId}", session "${sessionId}"`);

      // After the HTTP server starts it will serve /session directly
    }
  } else {
    // Single-session mode — load config from file
    await loadConfig(CONFIG_PATH);
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch(err => {
      console.error(err);
      res.writeHead(500); res.end('Internal error');
    });
  });

  const wss = new WebSocketServer({ server });
  wss.on('connection', async (ws) => {
    clients.add(ws);
    // Send initial state (only if a session is active)
    if (config.chatlog && fs.existsSync(config.chatlog)) {
      const raw     = await fsp.readFile(config.chatlog, 'utf8').catch(() => '');
      const entries = parseEntries(raw);
      ws.send(JSON.stringify({ type: 'init', entries: entries.slice(-500), total: entries.length, config, scores: computeScores(entries) }));
      for (const p of config.participants.filter(p => p.type === 'agent')) {
        ws.send(JSON.stringify({ type: 'agent_status', agent: getAgentStatus(p.id) }));
      }
    } else {
      // Workspace mode with no active session: send empty init
      ws.send(JSON.stringify({ type: 'init', entries: [], total: 0, config }));
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
    if (HAS_CONFIG) {
      console.log(`[agentorum] chatlog : ${config.chatlog}`);
      console.log(`[agentorum] config  : ${activeConfigPath}`);
    } else if (CLI_BUNDLE) {
      console.log(`[agentorum] mode    : bundle`);
      console.log(`[agentorum] chatlog : ${config.chatlog}`);
      console.log(`[agentorum] config  : ${activeConfigPath}`);
    } else {
      console.log(`[agentorum] mode    : workspace`);
    }
    if (AUTO_OPEN) {
      // When a bundle was loaded, open /session directly
      const openPath = CLI_BUNDLE ? '/session' : '/';
      const opener = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      spawn(opener, [`http://127.0.0.1:${PORT}${openPath}`], { shell: true, detached: true, stdio: 'ignore' }).unref();
    }
  });

  // Start chatlog watcher in single-session mode or when a bundle was loaded
  if (HAS_CONFIG || CLI_BUNDLE) {
    startChatlogWatcher();
  }
}

// ---------------------------------------------------------------------------
// Entry point — run directly OR imported by Electron
// ---------------------------------------------------------------------------

// Exported for Electron: import { startServer } from './server.mjs'
export async function startServer(opts = {}) {
  // opts.configPath overrides the --config CLI flag when called from Electron
  if (opts.configPath) {
    const idx = process.argv.indexOf('--config');
    if (idx !== -1) { process.argv[idx + 1] = opts.configPath; }
    else            { process.argv.push('--config', opts.configPath); }
  }
  // opts.workspaceDir can override the workspace directory
  if (opts.workspaceDir) {
    const idx = process.argv.indexOf('--workspace');
    if (idx !== -1) { process.argv[idx + 1] = opts.workspaceDir; }
    else            { process.argv.push('--workspace', opts.workspaceDir); }
  }
  return main();
}

// Auto-run when executed directly: node server.mjs
const isMain = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  main().catch(err => { console.error(err); process.exit(1); });
}
