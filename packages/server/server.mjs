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
let activeProjectId  = null;         // workspace project ID of the active session
let activeSessionId  = null;         // workspace session ID of the active session

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

    // ID is derived from timestamp + author + full raw content (meta + body).
    // Including content makes the ID collision-proof: two entries from the
    // same author within the same second — possible from rapid posts, retries,
    // or automation — will always have different content and therefore different
    // IDs.  The ID remains stable across server restarts because the chatlog is
    // append-only and the content of an existing entry never changes.
    entries.push({
      id:        sha256(`${ts}:${author}:${raw}`),
      timestamp: ts,
      author,
      body,
      meta       // e.g. { replyTo: 'abc123', stance: 'bull' }
    });
  }
  return entries;
}

function formatEntry(participantId, body, meta = {}) {
  // Use local time so timestamps are consistent with interactive agents
  // (which write local time directly). This avoids mixed UTC/local confusion.
  const d = new Date();
  const ts = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
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
      // Content-based routing (when routing mode is "auto")
      for (const entry of fresh) scheduleRouterClassification(entry);
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
  ], { stdio: ['ignore', 'pipe', 'pipe'], shell: false }); // node is always a real binary; shell not needed

  const state = { process: proc, status: 'running', pid: proc.pid, logs: [], lastResponseAt: null };
  agentProcs.set(id, state);

  // Prevent unhandled 'error' events from crashing the server
  proc.on('error', (err) => {
    console.error(`[agentorum] watcher spawn error for ${id}: ${err.message}`);
    state.status = 'error';
    state.pid    = null;
    broadcastAgentStatus(id);
  });

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
  // Interactive agents run in the user's own terminal — never spawned.
  if (participant.mode === 'interactive') {
    console.log(`[agentorum] triggerAgent: skipping ${participant.id} (mode=interactive)`);
    return;
  }

  // API agents use direct LLM API calls instead of CLI subprocess.
  if (participant.mode === 'api') {
    return triggerApiAgent(participant);
  }

  const raw    = await fsp.readFile(config.chatlog, 'utf8').catch(() => '');
  const prompt = buildPrompt(participant, raw);

  const agentCmd = (participant.agent || 'claude').toLowerCase();
  const [cmd, cmdArgs] = agentCmd === 'codex'
    ? ['codex', ['--full-auto']]
    : ['claude', ['--print']];

  return new Promise((resolve) => {
    // shell:true is required on Windows so that .cmd wrappers (claude.cmd,
    // codex.cmd) are found.  Without it, spawn throws ENOENT on Windows.
    const proc = spawn(cmd, cmdArgs, { stdio: ['pipe', 'pipe', 'pipe'], shell: true });

    // An unhandled 'error' event crashes the Node process.  Catch it here so
    // a missing or broken CLI is a logged warning, not a server crash.
    proc.on('error', (err) => {
      console.error(`[agentorum] failed to spawn ${cmd} for ${participant.id}: ${err.message}`);
      resolve('');
    });

    // Guard stdin: if spawn failed, writing to stdin emits an unhandled error
    // event on the stream that crashes the server.  Silence it here.
    proc.stdin.on('error', () => {});
    try {
      proc.stdin.write(prompt);
      proc.stdin.end();
    } catch { /* spawn failed; proc.on('error') handler above resolves */ }
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

// ---------------------------------------------------------------------------
// Direct LLM API agent backend
// ---------------------------------------------------------------------------
// Supports: anthropic (Claude), openai (GPT), google (Gemini)
// API keys are read from environment variables:
//   ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY
// The participant config specifies: { mode: "api", apiProvider: "anthropic"|"openai"|"google", apiModel: "model-name" }

async function triggerApiAgent(participant) {
  const provider = (participant.apiProvider || 'anthropic').toLowerCase();
  const model    = participant.apiModel || getDefaultModel(provider);

  const raw    = await fsp.readFile(config.chatlog, 'utf8').catch(() => '');
  const prompt = buildPrompt(participant, raw);

  const id = participant.id;
  agentProcesses[id] = { status: 'running', startedAt: new Date().toISOString() };
  broadcastAgentStatus(id);

  try {
    let response;
    if (provider === 'anthropic')    response = await callAnthropic(model, participant, prompt);
    else if (provider === 'openai')  response = await callOpenAI(model, participant, prompt);
    else if (provider === 'google')  response = await callGoogle(model, participant, prompt);
    else throw new Error(`Unknown API provider: ${provider}`);

    const text = (response || '').trim();
    if (text && text !== 'NO_RESPONSE_NEEDED') {
      const entry = formatEntry(id, text);
      await fsp.appendFile(config.chatlog, entry, 'utf8');
    }

    agentProcesses[id] = { status: 'stopped', lastResponseAt: new Date().toISOString() };
    broadcastAgentStatus(id);
    return text;
  } catch (err) {
    console.error(`[agentorum] API agent ${id} failed:`, err.message);
    agentProcesses[id] = { status: 'error', error: err.message };
    broadcastAgentStatus(id);
    return '';
  }
}

function getDefaultModel(provider) {
  if (provider === 'anthropic') return 'claude-sonnet-4-20250514';
  if (provider === 'openai')    return 'gpt-4o';
  if (provider === 'google')    return 'gemini-2.0-flash';
  return 'claude-sonnet-4-20250514';
}

async function callAnthropic(model, participant, prompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const sys = participant.systemPrompt?.trim() || `You are ${participant.id} in a structured multi-agent debate.`;
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system: sys,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (!resp.ok) throw new Error(`Anthropic API ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return data.content?.[0]?.text || '';
}

async function callOpenAI(model, participant, prompt) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');

  const sys = participant.systemPrompt?.trim() || `You are ${participant.id} in a structured multi-agent debate.`;
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: prompt }
      ],
      max_tokens: 4096
    })
  });
  if (!resp.ok) throw new Error(`OpenAI API ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return data.choices?.[0]?.message?.content || '';
}

async function callGoogle(model, participant, prompt) {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_API_KEY not set');

  const sys = participant.systemPrompt?.trim() || `You are ${participant.id} in a structured multi-agent debate.`;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: sys }] },
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 4096 }
    })
  });
  if (!resp.ok) throw new Error(`Google API ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

function broadcastAgentStatus(id) {
  broadcast({ type: 'agent_status', agent: getAgentStatus(id) });
}

// ---------------------------------------------------------------------------
// Ensemble endpoint — orchestrated multi-agent debate
// ---------------------------------------------------------------------------

function extractJsonGrid(text) {
  // Strategy: search ALL fenced code blocks for one containing a "grid" key.
  // If multiple match, prefer the last one (the final answer).
  const fenceRe = /```(?:json)?\s*\n?([\s\S]*?)```/g;
  let fenceMatch;
  let bestObj = null;
  while ((fenceMatch = fenceRe.exec(text)) !== null) {
    const block = fenceMatch[1].trim();
    try {
      const obj = JSON.parse(block);
      if (obj.grid && Array.isArray(obj.grid)) bestObj = obj;
    } catch {}
  }
  if (bestObj) return bestObj;

  // Fallback: find a JSON object with "grid" anywhere in the text
  // Use a pattern that matches the object containing the grid key
  const allObjMatches = text.matchAll(/\{\s*"grid"\s*:\s*(\[[\s\S]*?\])\s*[,}]/g);
  for (const m of allObjMatches) {
    try {
      const grid = JSON.parse(m[1]);
      if (Array.isArray(grid) && Array.isArray(grid[0])) bestObj = { grid };
    } catch {}
  }
  if (bestObj) return bestObj;

  // Last resort: find the LAST bare 2D array in the text
  const allArrMatches = [...text.matchAll(/\[\s*\[[\s\S]*?\]\s*\]/g)];
  const lastArr = allArrMatches.length ? allArrMatches[allArrMatches.length - 1][0] : null;
  if (lastArr) {
    try {
      const grid = JSON.parse(lastArr);
      if (Array.isArray(grid) && Array.isArray(grid[0])) return { grid };
    } catch {}
  }

  return null;
}

function gridsEqual(a, b) {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].length !== b[i].length) return false;
    for (let j = 0; j < a[i].length; j++) {
      if (a[i][j] !== b[i][j]) return false;
    }
  }
  return true;
}

function formatTaskForPrompt(task) {
  let s = 'Here is an ARC-AGI puzzle. Study the demonstration pairs to discover the transformation rule, then apply it to the test input.\n\n';
  task.train.forEach((pair, i) => {
    s += `**Demo ${i + 1} — Input:**\n\`\`\`json\n${JSON.stringify(pair.input)}\n\`\`\`\n`;
    s += `**Demo ${i + 1} — Output:**\n\`\`\`json\n${JSON.stringify(pair.output)}\n\`\`\`\n\n`;
  });
  s += `**Test Input:**\n\`\`\`json\n${JSON.stringify(task.test[0].input)}\n\`\`\`\n\n`;
  s += 'What is the test output? Apply the transformation rule you discovered from the demo pairs.';
  return s;
}

function formatDebateLog(log) {
  return log.map(e => `**[Round ${e.round} — ${e.agent}]:**\n${e.content}`).join('\n\n---\n\n');
}

async function callAgent(participant, prompt, maxTokens = 4096) {
  const provider = participant.apiProvider || 'anthropic';
  const model    = participant.apiModel || getDefaultModel(provider);
  if (provider === 'openai')    return callOpenAI(model, participant, prompt);
  if (provider === 'google')    return callGoogle(model, participant, prompt);
  return callAnthropic(model, participant, prompt);
}

async function runEnsemble(body) {
  const startMs = Date.now();
  const { prompt, task, context, config: userConfig } = body;

  // Load scenario config and prompts
  const scenarioPath = userConfig?.scenarioPath
    || path.resolve(__dirname, '../../usecases/arc-agi-ensemble/arc-agi-ensemble.scenario.json');
  const scenario = JSON.parse(await fsp.readFile(scenarioPath, 'utf8'));
  const scenarioDir = path.dirname(scenarioPath);

  // Build participant objects with system prompts loaded from files
  const participants = {};
  for (const p of scenario.participants) {
    const promptFile = p.systemPromptFile
      ? path.resolve(scenarioDir, p.systemPromptFile)
      : null;
    const systemPrompt = promptFile
      ? await fsp.readFile(promptFile, 'utf8').catch(() => '')
      : '';
    participants[p.id] = { ...p, systemPrompt };
  }

  const solverIds  = ['SOLVER-SPATIAL', 'SOLVER-PROCEDURAL', 'SOLVER-ANALOGICAL'];
  const maxRounds  = userConfig?.maxRounds ?? scenario.ensemble?.maxRounds ?? 4;
  const convergenceEnabled = userConfig?.convergenceEnabled ?? scenario.ensemble?.convergenceEnabled ?? true;

  // Build the initial task prompt
  const arcTask    = task || (typeof prompt === 'string' ? JSON.parse(prompt) : prompt);
  const taskPrompt = formatTaskForPrompt(arcTask);
  const contextStr = context ? `\n\n**Context from previous tasks:**\n${context}` : '';

  const debate = [];
  let converged = false;
  let totalTokens = 0;

  // ── Round 1: Three solvers propose independently (parallel) ──────────
  console.log('[ensemble] Round 1: solvers propose...');
  const round1Results = await Promise.all(
    solverIds.map(async id => {
      const content = await callAgent(participants[id], taskPrompt + contextStr);
      return { round: 1, agent: id, content };
    })
  );
  debate.push(...round1Results);

  // Check convergence: all three grids identical?
  const round1Grids = round1Results.map(r => extractJsonGrid(r.content));
  const allSame = round1Grids[0]?.grid
    && round1Grids.every(g => g?.grid && gridsEqual(g.grid, round1Grids[0].grid));

  if (allSame && convergenceEnabled) {
    console.log('[ensemble] All solvers agree — running CRITIC confirmation...');
    const confirmPrompt = taskPrompt + '\n\n' + formatDebateLog(debate)
      + '\n\nAll three solvers produced the same answer. Verify it against ALL demo pairs. Confirm or challenge.';
    const criticContent = await callAgent(participants['CRITIC'], confirmPrompt);
    debate.push({ round: 2, agent: 'CRITIC', content: criticContent });

    const confirmed = /\bPASS\b/i.test(criticContent) && !/\bFAIL\b/i.test(criticContent);
    if (confirmed) {
      console.log('[ensemble] CRITIC confirmed — converged in 2 rounds.');
      const mediatorPrompt = taskPrompt + '\n\n' + formatDebateLog(debate)
        + '\n\nAll solvers agree and CRITIC confirmed. Endorse the consensus answer and extract a lesson.' + contextStr;
      const mediatorContent = await callAgent(participants['MEDIATOR'], mediatorPrompt);
      debate.push({ round: 3, agent: 'MEDIATOR', content: mediatorContent });

      const finalGrid = extractJsonGrid(mediatorContent) || round1Grids[0];
      converged = true;
      return {
        answer: finalGrid?.grid || null,
        debate,
        metadata: {
          rounds: 3, converged: true,
          durationMs: Date.now() - startMs,
          agents: Object.keys(participants).length
        }
      };
    }
    // CRITIC challenged — fall through to Round 3
  }

  // ── Round 2: CRITIC evaluates (if not convergence path) ──────────────
  if (!allSame || !convergenceEnabled) {
    console.log('[ensemble] Round 2: CRITIC evaluates...');
    const criticPrompt = taskPrompt + '\n\n' + formatDebateLog(debate)
      + '\n\nEvaluate each solver\'s proposed rule. Apply each rule to ALL demo pairs and report PASS or FAIL for each.';
    const criticContent = await callAgent(participants['CRITIC'], criticPrompt);
    debate.push({ round: 2, agent: 'CRITIC', content: criticContent });
  }

  // ── Round 3: Solvers revise based on CRITIC feedback (parallel) ──────
  if (maxRounds >= 3) {
    console.log('[ensemble] Round 3: solvers revise...');
    const round3Results = await Promise.all(
      solverIds.map(async id => {
        const revisePrompt = taskPrompt + '\n\n' + formatDebateLog(debate)
          + `\n\nYou are ${id}. The CRITIC has evaluated your proposal and the other solvers' proposals. `
          + 'Revise your answer if the CRITIC found flaws, or defend it with more detail. '
          + 'Also consider the other solvers\' proposals — can you improve your answer by incorporating their insights?' + contextStr;
        const content = await callAgent(participants[id], revisePrompt);
        return { round: 3, agent: id, content };
      })
    );
    debate.push(...round3Results);
  }

  // ── Round 4: MEDIATOR makes final decision ───────────────────────────
  console.log('[ensemble] Round 4: MEDIATOR decides...');
  const mediatorPrompt = taskPrompt + '\n\n' + formatDebateLog(debate)
    + '\n\nYou have read the full debate. Make your final decision: produce the output grid. '
    + 'Explain your reasoning, then output the grid in JSON format.' + contextStr;
  const mediatorContent = await callAgent(participants['MEDIATOR'], mediatorPrompt);
  debate.push({ round: 4, agent: 'MEDIATOR', content: mediatorContent });

  const finalGrid = extractJsonGrid(mediatorContent);

  return {
    answer: finalGrid?.grid || null,
    debate,
    metadata: {
      rounds: maxRounds, converged,
      durationMs: Date.now() - startMs,
      agents: Object.keys(participants).length
    }
  };
}

// ---------------------------------------------------------------------------
// Automation rules
// ---------------------------------------------------------------------------
// Returns true if this participant can be triggered via the watcher/subprocess or API path.
// 'interactive' agents run in the user's own terminal — the server must not spawn for them.
// Both watcher (CLI subprocess) and API agents are triggerable via automation rules.
function isWatcherTriggerable(participant) {
  return participant.mode !== 'interactive';
}

function evaluateRules(entry) {
  for (const rule of (config.automationRules || [])) {
    if (!rule.enabled) continue;
    if (rule.trigger?.type === 'entry_from' && rule.trigger?.author === entry.author) {
      const participant = config.participants.find(p => p.id === rule.action?.agentId);
      if (participant) {
        if (isWatcherTriggerable(participant)) {
          // Watcher mode: spawn/trigger the subprocess automatically
          setTimeout(() => triggerAgent(participant), rule.action?.delayMs ?? 0);
        } else if (participant.mode === 'interactive') {
          // Interactive mode: can't auto-trigger — nudge the UI instead so the
          // user knows to prompt this agent manually in their terminal
          setTimeout(() => broadcast({
            type: 'agent_nudge',
            agentId: participant.id,
            triggeredBy: entry.author
          }), rule.action?.delayMs ?? 0);
        }
      }
    }
    // every_n_entries rule: check total entry count
    // Supports spec format { type: "every_n_entries", n: 5 } and legacy { type: "every_5_entries" }
    const triggerType = rule.trigger?.type || '';
    const everyNMatch = triggerType.match(/^every_(\d+)_entries$/);
    const isEveryN    = triggerType === 'every_n_entries' || everyNMatch;
    if (isEveryN) {
      const n = rule.trigger?.n || (everyNMatch ? parseInt(everyNMatch[1], 10) : 5);
      const total = _lastEntries.length;
      if (n > 0 && total > 0 && total % n === 0) {
        const participant = config.participants.find(p => p.id === rule.action?.agentId);
        if (participant && isWatcherTriggerable(participant)) {
          setTimeout(() => triggerAgent(participant), rule.action?.delayMs ?? 0);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Lightweight Router (content-based agent triggering)
// ---------------------------------------------------------------------------
// When routing mode is "auto" in the config, the router classifies each new
// entry by topic tags and triggers only agents whose respondWhen keywords
// match. Uses Anthropic Haiku for fast, cheap classification.
//
// Enabled by: { "routing": "auto" } in agentorum.config.json
// Falls back to rule-based triggering when routing is "rules" (default).

let routerDebounceTimer = null;
let routerPendingEntries = [];

function scheduleRouterClassification(entry) {
  if (config.routing !== 'auto') return;
  routerPendingEntries.push(entry);
  clearTimeout(routerDebounceTimer);
  routerDebounceTimer = setTimeout(() => {
    const batch = [...routerPendingEntries];
    routerPendingEntries = [];
    routeEntries(batch);
  }, 2000); // 2-second debounce
}

async function routeEntries(entries) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('[agentorum] router: ANTHROPIC_API_KEY not set, falling back to rule-based triggering');
    return;
  }

  const triggerableAgents = (config.participants || [])
    .filter(p => p.mode !== 'interactive' && p.mode !== 'human' && p.agent !== 'human' && p.type !== 'human');

  if (triggerableAgents.length === 0) return;

  // Build role directory for the router
  const roleDir = triggerableAgents.map(p => {
    const topics = (p.respondWhen || []).join(', ') || p.role || p.id;
    return `- ${p.id}: ${topics}`;
  }).join('\n');

  const entryTexts = entries.map(e =>
    `[${e.author}]: ${e.body.slice(0, 300)}`
  ).join('\n---\n');

  const routerPrompt = `You are a message router. Given the entries below and the agent role directory, output a JSON array of agent IDs that should be triggered to respond. Only include agents whose expertise is relevant to the entry content. If no agents are relevant, output an empty array.

Role directory:
${roleDir}

Entries:
${entryTexts}

Output ONLY a JSON array of agent IDs, e.g.: ["SECURITY-ANALYST", "BACKEND-DEV"]`;

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-20250514',
        max_tokens: 256,
        messages: [{ role: 'user', content: routerPrompt }]
      })
    });

    if (!resp.ok) {
      console.warn(`[agentorum] router API error: ${resp.status}`);
      return;
    }

    const data = await resp.json();
    const text = data.content?.[0]?.text || '[]';

    // Parse the JSON array of agent IDs
    let agentIds;
    try {
      const match = text.match(/\[[\s\S]*\]/);
      agentIds = match ? JSON.parse(match[0]) : [];
    } catch {
      console.warn('[agentorum] router: failed to parse response:', text);
      return;
    }

    // Log routing decision
    const sessionDir = path.dirname(config.chatlog);
    const logLine = JSON.stringify({
      timestamp: new Date().toISOString(),
      entries: entries.map(e => e.id),
      routed: agentIds
    }) + '\n';
    fsp.appendFile(path.join(sessionDir, 'routing-log.jsonl'), logLine, 'utf8').catch(() => {});

    // Trigger the selected agents
    for (const agentId of agentIds) {
      const participant = config.participants.find(p => p.id === agentId);
      if (participant && participant.mode !== 'interactive') {
        triggerAgent(participant);
      }
    }

    console.log(`[agentorum] router: triggered ${agentIds.length} agents: ${agentIds.join(', ') || '(none)'}`);
  } catch (err) {
    console.warn('[agentorum] router error:', err.message);
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
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
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

    // PATCH /api/workspace  (rename workspace)
    if (pathname === '/api/workspace' && method === 'PATCH') {
      try {
        const { name } = JSON.parse(await readBody(req));
        return jsonResp(res, await workspaceManager.renameWorkspace(name));
      } catch (err) {
        return jsonResp(res, { error: err.message }, 400);
      }
    }

    // GET /api/projects/:projectId/search?q=...
    const searchMatch = pathname.match(/^\/api\/projects\/([^/]+)\/search$/);
    if (searchMatch && method === 'GET') {
      const [, projectId] = searchMatch;
      const q = new URL(`http://x${req.url}`).searchParams.get('q') || '';
      try {
        return jsonResp(res, await workspaceManager.searchSessions(projectId, q));
      } catch (err) {
        return jsonResp(res, { error: err.message }, 400);
      }
    }

    // GET /api/scenarios   POST /api/scenarios (save user scenario)
    if (pathname === '/api/scenarios') {
      if (method === 'GET') {
        try {
          return jsonResp(res, await workspaceManager.listScenarios());
        } catch (err) {
          return jsonResp(res, { error: err.message }, 500);
        }
      }
      if (method === 'POST') {
        try {
          const scenario = JSON.parse(await readBody(req));
          await workspaceManager.saveUserScenario(scenario);
          return jsonResp(res, { ok: true }, 201);
        } catch (err) {
          return jsonResp(res, { error: err.message }, 400);
        }
      }
    }

    // DELETE /api/scenarios/:id  (user scenarios only)
    const scMatch = pathname.match(/^\/api\/scenarios\/([^/]+)$/);
    if (scMatch && method === 'DELETE') {
      const [, scenarioId] = scMatch;
      try {
        await workspaceManager.deleteUserScenario(scenarioId);
        return jsonResp(res, { ok: true });
      } catch (err) {
        return jsonResp(res, { error: err.message }, 400);
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

    // GET /api/projects/:projectId   DELETE /api/projects/:projectId
    const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
    if (projectMatch && method === 'GET') {
      const [, projectId] = projectMatch;
      try {
        return jsonResp(res, await workspaceManager.getProject(projectId));
      } catch (err) {
        return jsonResp(res, { error: err.message }, 404);
      }
    }
    if (projectMatch && method === 'DELETE') {
      const [, projectId] = projectMatch;
      try {
        // Block deletion of the currently active project
        if (activeConfigPath) {
          const activeProjDir = path.join(workspaceManager.projectsDir, projectId);
          if (activeConfigPath.startsWith(activeProjDir + path.sep) ||
              activeConfigPath.startsWith(activeProjDir + '/')) {
            return jsonResp(res, { error: 'Cannot delete the active project. Open a different session first.' }, 400);
          }
        }
        await workspaceManager.deleteProject(projectId);
        return jsonResp(res, { ok: true });
      } catch (err) {
        return jsonResp(res, { error: err.message }, 404);
      }
    }

    // PATCH /api/projects/:projectId  (rename)
    if (projectMatch && method === 'PATCH') {
      const [, projectId] = projectMatch;
      try {
        const { name } = JSON.parse(await readBody(req));
        const data = await workspaceManager.renameProject(projectId, name);
        return jsonResp(res, data);
      } catch (err) {
        return jsonResp(res, { error: err.message }, 400);
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

    // PATCH /api/sessions/:projectId/:sessionId  (rename)
    const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/([^/]+)$/);
    if (sessionMatch && method === 'PATCH') {
      const [, projectId, sessionId] = sessionMatch;
      try {
        const { name } = JSON.parse(await readBody(req));
        const data = await workspaceManager.renameSession(projectId, sessionId, name);
        return jsonResp(res, data);
      } catch (err) {
        return jsonResp(res, { error: err.message }, 400);
      }
    }

    // PATCH /api/sessions/:projectId/:sessionId/archive
    const archiveMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/([^/]+)\/archive$/);
    if (archiveMatch && method === 'PATCH') {
      const [, projectId, sessionId] = archiveMatch;
      try {
        const { archived } = JSON.parse(await readBody(req));
        const ws = workspaceManager.workspace;
        if (ws?.lastSession?.sessionId === sessionId && ws?.lastSession?.projectId === projectId) {
          return jsonResp(res, { error: 'Cannot archive the active session' }, 400);
        }
        return jsonResp(res, await workspaceManager.setSessionArchived(projectId, sessionId, !!archived));
      } catch (err) {
        return jsonResp(res, { error: err.message }, 400);
      }
    }

    // PATCH /api/sessions/:projectId/:sessionId/description
    const descMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/([^/]+)\/description$/);
    if (descMatch && method === 'PATCH') {
      const [, projectId, sessionId] = descMatch;
      try {
        const { description } = JSON.parse(await readBody(req));
        return jsonResp(res, await workspaceManager.updateSessionDescription(projectId, sessionId, description));
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
        activeProjectId  = projectId;
        activeSessionId  = sessionId;
        await loadConfig(configPath);
        await loadSessionToken();

        // Restart chatlog watcher for new chatlog
        startChatlogWatcher();

        // Broadcast updated config to connected clients
        broadcast({ type: 'config_updated', config });

        // Refresh interactive agents' rules files with the current session token
        // and notify them via the chatlog to re-read.
        try {
          const result = await workspaceManager.regenerateRulesFiles(projectId, sessionId, CLI_PORT);
          if (result && result.updated.length > 0 && result.chatlogPath) {
            const lines = result.updated.map(a =>
              `@${a.id}: Your rules file has been updated. Please re-read:\n  ${a.rulesFilePath}`
            );
            const body = `Rules files refreshed for this session.\n\n${lines.join('\n\n')}`;
            await fsp.appendFile(result.chatlogPath, formatEntry('SYSTEM', body), 'utf8');
          }
        } catch (rulesErr) {
          console.warn('[agentorum] rules regen failed (non-fatal):', rulesErr.message);
        }

        // Update session lastActive and persist as the last-used session
        await workspaceManager.updateSessionLastActive(projectId, sessionId);
        await workspaceManager.saveLastActiveSession(projectId, sessionId);

        return jsonResp(res, { ok: true, redirectTo: '/session' });
      } catch (err) {
        console.error('[agentorum] session open error:', err);
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
        await workspaceManager.saveLastActiveSession(projectId, sessionId);

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
            message: `Session token incorrect. Re-initialize your agent: Read this file and confirm your role: ${path.join(sessionDir, `rules-${author}.txt`)}`
          }, 401);
        }
      }
    }
    await fsp.appendFile(config.chatlog, formatEntry(author, body, meta || {}), 'utf8');

    // Write trigger file so interactive agents watching the session dir can respond
    if (activeConfigPath) {
      const triggerPath = path.join(path.dirname(activeConfigPath), 'trigger.json');
      fsp.writeFile(triggerPath, JSON.stringify({
        timestamp: new Date().toISOString(),
        author, body: body.slice(0, 500),
        sessionDir: path.dirname(activeConfigPath),
        projectId: activeProjectId,
        sessionId: activeSessionId
      }), 'utf8').catch(() => {});
    }

    return jsonResp(res, { ok: true });
  }

  // --- DELETE /api/entries/:id — remove a single entry from the chatlog ---
  const entryDeleteMatch = pathname.match(/^\/api\/entries\/([a-f0-9]+)$/);
  if (entryDeleteMatch && method === 'DELETE') {
    const targetId = entryDeleteMatch[1];
    if (!config.chatlog) return jsonResp(res, { error: 'No chatlog configured' }, 400);
    const raw = await fsp.readFile(config.chatlog, 'utf8').catch(() => '');
    const entries = parseEntries(raw);
    const entry = entries.find(e => e.id === targetId);
    if (!entry) return jsonResp(res, { error: 'Entry not found' }, 404);

    // Rebuild the chatlog without the deleted entry.
    // We re-split the raw file by entry headers and remove the matching block.
    const normalized = raw.replace(/\r\n/g, '\n');
    const headerMatches = [];
    ENTRY_RE.lastIndex = 0;
    let m;
    while ((m = ENTRY_RE.exec(normalized)) !== null) {
      headerMatches.push({ ts: m[1], author: m[2], headerEnd: ENTRY_RE.lastIndex, headerStart: m.index });
    }
    let removeStart = -1, removeEnd = -1;
    for (let i = 0; i < headerMatches.length; i++) {
      const { ts, author, headerEnd } = headerMatches[i];
      const nextStart = i + 1 < headerMatches.length ? headerMatches[i+1].headerStart : normalized.length;
      const rawBody = normalized.slice(headerEnd, nextStart).trim();
      const id = sha256(`${ts}:${author}:${rawBody}`);
      if (id === targetId) {
        removeStart = headerMatches[i].headerStart;
        removeEnd = nextStart;
        break;
      }
    }
    if (removeStart < 0) return jsonResp(res, { error: 'Entry not found in file' }, 404);
    const updated = normalized.slice(0, removeStart) + normalized.slice(removeEnd);
    await fsp.writeFile(config.chatlog, updated, 'utf8');
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
    return jsonResp(res, { active: true, sessionDir, token: activeSessionToken, projectId: activeProjectId, sessionId: activeSessionId, interactiveParticipants });
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

  // --- /api/export --- Download chatlog as HTML or Markdown ---
  if (pathname === '/api/export' && method === 'GET') {
    if (!activeConfigPath) return jsonResp(res, { error: 'no active session' }, 404);
    const format = new URL(`http://x${req.url}`).searchParams.get('format') || 'html';
    try {
      const raw     = await fsp.readFile(config.chatlog, 'utf8').catch(() => '');
      const entries = parseEntries(raw);
      const sessionDir  = path.dirname(activeConfigPath);
      const sessionName = path.basename(sessionDir);
      const projectName = path.basename(path.dirname(path.dirname(sessionDir)));
      const exportedAt  = new Date().toLocaleString();

      if (format === 'md') {
        const lines = [`# ${projectName} / ${sessionName}`, ``, `_Exported ${exportedAt} · ${entries.length} entries_`, ``];
        entries.forEach(e => {
          lines.push(`## ${e.author} — ${e.timestamp}`);
          lines.push(``);
          lines.push(e.body);
          lines.push(``);
          lines.push(`---`);
          lines.push(``);
        });
        const md       = lines.join('\n');
        const filename = `${projectName}-${sessionName}.md`;
        res.writeHead(200, {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}"`,
        });
        res.end(md);
        return;
      }

      const rows = entries.map(e => {
        const body = e.body
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/\n/g, '<br>');
        return `<div class="entry">
          <div class="entry-header"><span class="author">${e.author}</span><span class="ts">${e.timestamp}</span></div>
          <div class="entry-body">${body}</div>
        </div>`;
      }).join('\n');

      const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${projectName} — ${sessionName}</title>
<style>
body{font-family:system-ui,sans-serif;max-width:820px;margin:40px auto;padding:0 20px;background:#0f1117;color:#e2e8f0}
h1{font-size:20px;font-weight:700;margin-bottom:4px}
.meta{font-size:12px;color:#64748b;margin-bottom:32px}
.entry{border:1px solid #1e293b;border-radius:8px;padding:14px 16px;margin-bottom:12px;background:#1e293b}
.entry-header{display:flex;align-items:baseline;gap:12px;margin-bottom:8px}
.author{font-size:12px;font-weight:700;color:#60a5fa;letter-spacing:.05em}
.ts{font-size:11px;color:#475569}
.entry-body{font-size:14px;line-height:1.6;white-space:pre-wrap}
</style>
</head>
<body>
<h1>${projectName} / ${sessionName}</h1>
<div class="meta">Exported ${exportedAt} · ${entries.length} entries</div>
${rows}
</body>
</html>`;

      const filename = `${projectName}-${sessionName}.html`;
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      });
      res.end(html);
    } catch (err) {
      return jsonResp(res, { error: err.message }, 500);
    }
  }

  // --- /api/summary --- GET returns current summary.md; PUT saves it ---
  if (pathname === '/api/summary') {
    if (!activeConfigPath) return jsonResp(res, { error: 'no active session' }, 404);
    const summaryPath = path.join(path.dirname(activeConfigPath), 'summary.md');
    if (method === 'GET') {
      try {
        const content = await fsp.readFile(summaryPath, 'utf8');
        return jsonResp(res, { content });
      } catch {
        return jsonResp(res, { content: '' });
      }
    }
    if (method === 'PUT') {
      const { content } = JSON.parse(await readBody(req));
      if (typeof content !== 'string') return jsonResp(res, { error: 'content required' }, 400);
      await fsp.writeFile(summaryPath, content, 'utf8');
      return jsonResp(res, { ok: true });
    }
  }

  // --- /api/participants (also aliased as /api/agents for spec compatibility) ---
  if ((pathname === '/api/participants' || pathname === '/api/agents') && method === 'GET') {
    return jsonResp(res, config.participants.map(p => ({ ...p, ...getAgentStatus(p.id) })));
  }

  const pMatch = pathname.match(/^\/api\/(?:participants|agents)\/([^/]+)\/(\w+)$/);
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

  // ---------------------------------------------------------------------------
  // POST /api/ensemble — synchronous multi-agent ensemble endpoint
  //
  // Orchestrates a structured debate among API-mode agents and returns a
  // single consolidated answer.  The ensemble appears as one agent to the
  // caller.  Currently supports ARC-AGI-2 tasks but the protocol is generic.
  // ---------------------------------------------------------------------------
  if (pathname === '/api/ensemble' && method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const result = await runEnsemble(body);
      return jsonResp(res, result);
    } catch (err) {
      console.error('[ensemble] error:', err);
      return jsonResp(res, { error: err.message }, 500);
    }
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

    // --bundle: load (or resume) a bundle's project and session
    if (CLI_BUNDLE) {
      const bundlePath = path.resolve(CLI_BUNDLE);
      const result     = await workspaceManager.loadBundle(bundlePath);
      const { projectId, sessionId, configPath } = result;

      activeConfigPath = configPath;
      activeProjectId  = projectId;
      activeSessionId  = sessionId;
      await loadConfig(configPath);
      await loadSessionToken();
      await workspaceManager.saveLastActiveSession(projectId, sessionId);
      // Regenerate rules files so interactive agents get fresh tokens and instructions
      try { await workspaceManager.regenerateRulesFiles(projectId, sessionId, CLI_PORT); }
      catch (e) { console.warn('[agentorum] rules regen on startup failed (non-fatal):', e.message); }

      console.log(`[agentorum] bundle   : project=${projectId} session=${sessionId}`);
    } else {
      // No --bundle: try to restore the last active session from workspace.json
      const last = await workspaceManager.getLastActiveSession();
      if (last) {
        activeConfigPath = last.configPath;
        activeProjectId  = last.projectId;
        activeSessionId  = last.sessionId;
        await loadConfig(last.configPath);
        await loadSessionToken();
        // Regenerate rules files so interactive agents get fresh tokens and instructions
        try { await workspaceManager.regenerateRulesFiles(last.projectId, last.sessionId, CLI_PORT); }
        catch (e) { console.warn('[agentorum] rules regen on startup failed (non-fatal):', e.message); }
        console.log(`[agentorum] restored : project=${last.projectId} session=${last.sessionId}`);
      }
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
      ws.send(JSON.stringify({ type: 'init', entries: entries.slice(-500), total: entries.length, config, scores: computeScores(entries), projectId: activeProjectId, sessionId: activeSessionId }));
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
    } else if (activeConfigPath) {
      // Workspace mode with an active session (bundle or restored)
      console.log(`[agentorum] chatlog : ${config.chatlog}`);
      console.log(`[agentorum] config  : ${activeConfigPath}`);
    } else {
      console.log(`[agentorum] mode    : workspace (no active session)`);
    }
    if (AUTO_OPEN) {
      // Open /session directly when there is an active session to show
      const openPath = activeConfigPath ? '/session' : '/';
      const opener = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      spawn(opener, [`http://127.0.0.1:${PORT}${openPath}`], { shell: true, detached: true, stdio: 'ignore' }).unref();
    }
  });

  // Start chatlog watcher whenever an active session is configured
  if (activeConfigPath) {
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
