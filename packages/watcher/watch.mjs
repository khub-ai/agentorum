// Agentorum — watch.mjs
// Standalone file watcher. Monitors the chatlog and triggers an AI agent
// to respond when a new entry arrives from a configured participant.
// Designed to be spawned as a child process by server.mjs, or run standalone.

import fs          from 'node:fs';
import fsp         from 'node:fs/promises';
import crypto      from 'node:crypto';
import { spawn }   from 'node:child_process';
import path        from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// CLI arguments
// ---------------------------------------------------------------------------
const args    = process.argv.slice(2);
const getArg  = (name, def) => { const i = args.indexOf(`--${name}`); return i !== -1 && args[i+1] ? args[i+1] : def; };
const hasFlag = (name) => args.includes(`--${name}`);

const PARTICIPANT_ID = getArg('participant-id', 'AGENT-1');
const AGENT_CMD      = getArg('agent', 'claude');
const RESPOND_TO     = getArg('respond-to', 'HUMAN').split(',').map(s => s.trim()).filter(Boolean);
const CHATLOG        = path.resolve(getArg('chatlog', 'chatlog.md'));
const CONFIG_PATH    = path.resolve(getArg('config', 'agentorum.config.json'));
const RULES_PATH     = getArg('rules', null);
const DEBOUNCE_MS    = parseInt(getArg('debounce', '2000'), 10);
const DRY_RUN        = hasFlag('dry-run');

// ---------------------------------------------------------------------------
// Participant config (loaded from agentorum.config.json)
// ---------------------------------------------------------------------------
let participantConfig = null;

async function loadParticipantConfig() {
  try {
    const raw  = await fsp.readFile(CONFIG_PATH, 'utf8');
    const cfg  = JSON.parse(raw);
    participantConfig = (cfg.participants || []).find(p => p.id === PARTICIPANT_ID) || null;
  } catch {
    participantConfig = null;
  }
}

// ---------------------------------------------------------------------------
// Chatlog parsing
// ---------------------------------------------------------------------------
const ENTRY_RE = /^###\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s+-\s+(\S+)\s*$/gm;

function parseLastEntry(content) {
  const normalized = content.replace(/\r\n/g, '\n');
  ENTRY_RE.lastIndex = 0;
  let lastMatch = null;
  let m;
  while ((m = ENTRY_RE.exec(normalized)) !== null) lastMatch = m;
  if (!lastMatch) return null;
  const ts     = lastMatch[1];
  const author = lastMatch[2];
  const body   = normalized.slice(ENTRY_RE.lastIndex).trim();
  return { ts, author, body };
}

// ---------------------------------------------------------------------------
// State persistence (prevents re-processing the same content)
// ---------------------------------------------------------------------------
const STATE_FILE = path.resolve(
  path.dirname(CHATLOG),
  `.watch-state-${PARTICIPANT_ID.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`
);

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

async function loadState() {
  try { return JSON.parse(await fsp.readFile(STATE_FILE, 'utf8')); }
  catch { return { lastHash: null, lastProcessed: null }; }
}

async function saveState(state) {
  await fsp.writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// Rules file (shared instructions for all agents)
// ---------------------------------------------------------------------------
let rulesContent = null;

async function loadRules() {
  // Explicit --rules path takes priority, then look for rules.txt next to chatlog
  const candidates = [
    RULES_PATH ? path.resolve(RULES_PATH) : null,
    path.resolve(path.dirname(CHATLOG), 'rules.txt')
  ].filter(Boolean);

  for (const p of candidates) {
    try {
      rulesContent = (await fsp.readFile(p, 'utf8')).trim();
      console.log(`[${PARTICIPANT_ID}] rules loaded: ${p}`);
      return;
    } catch { /* try next */ }
  }
  rulesContent = null;
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------
function buildPrompt(chatlogContent) {
  const sys = participantConfig?.systemPrompt?.trim()
    || `You are ${PARTICIPANT_ID}, a participant in a structured multi-agent debate.`;

  const rulesSection = rulesContent
    ? `\nSHARED RULES:\n${rulesContent}\n`
    : '';

  return `${sys}
${rulesSection}
CHATLOG:
${chatlogContent}

---
Task: Read the chatlog above. Decide whether ${PARTICIPANT_ID} should write a response to the most recent entry.

- If a response IS needed: write ONLY the response body. Do not include the header line — it is added automatically.
- If no response is needed: output exactly this token and nothing else: NO_RESPONSE_NEEDED
`;
}

// ---------------------------------------------------------------------------
// Agent invocation
// ---------------------------------------------------------------------------
function formatEntry(body) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  return `\n### ${ts} - ${PARTICIPANT_ID}\n\n${body}\n`;
}

async function invokeAgent(chatlogContent) {
  const prompt   = buildPrompt(chatlogContent);
  const agentCmd = (AGENT_CMD || 'claude').toLowerCase();
  const [cmd, cmdArgs] = agentCmd === 'codex'
    ? ['codex', ['--full-auto']]
    : ['claude', ['--print']];

  console.log(`[${PARTICIPANT_ID}] invoking ${cmd}…`);

  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, cmdArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
    proc.stdin.write(prompt);
    proc.stdin.end();

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(`Agent exited ${code}: ${stderr.trim()}`));
      } else {
        resolve(stdout.trim());
      }
    });
    proc.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Main processing loop
// ---------------------------------------------------------------------------
let debounceTimer = null;
let processing    = false;

async function processChange() {
  if (processing) return;
  processing = true;

  try {
    const raw     = await fsp.readFile(CHATLOG, 'utf8');
    const content = raw.replace(/\r\n/g, '\n');
    const hash    = sha256(content);
    const state   = await loadState();

    // Guard 1: already processed this exact content
    if (hash === state.lastHash) {
      console.log(`[${PARTICIPANT_ID}] no change since last run, skipping`);
      return;
    }

    const last = parseLastEntry(content);
    if (!last) {
      console.log(`[${PARTICIPANT_ID}] chatlog empty or unparseable`);
      await saveState({ lastHash: hash, lastProcessed: new Date().toISOString() });
      return;
    }

    // Guard 2: last entry is from this agent itself (self-echo)
    if (last.author === PARTICIPANT_ID) {
      console.log(`[${PARTICIPANT_ID}] last entry is self, skipping`);
      await saveState({ lastHash: hash, lastProcessed: new Date().toISOString() });
      return;
    }

    // Guard 3: last entry not from a participant we respond to
    if (!RESPOND_TO.includes(last.author)) {
      console.log(`[${PARTICIPANT_ID}] last author "${last.author}" not in respond-to list [${RESPOND_TO}], skipping`);
      await saveState({ lastHash: hash, lastProcessed: new Date().toISOString() });
      return;
    }

    console.log(`[${PARTICIPANT_ID}] responding to "${last.author}" at ${last.ts}…`);

    if (DRY_RUN) {
      console.log(`[${PARTICIPANT_ID}] DRY RUN — would invoke agent, no file written`);
      await saveState({ lastHash: hash, lastProcessed: new Date().toISOString() });
      return;
    }

    // Invoke the AI agent
    const response = await invokeAgent(content);

    if (!response || response === 'NO_RESPONSE_NEEDED') {
      console.log(`[${PARTICIPANT_ID}] agent chose not to respond`);
      await saveState({ lastHash: hash, lastProcessed: new Date().toISOString() });
      return;
    }

    // Append response to chatlog
    const entry = formatEntry(response);
    await fsp.appendFile(CHATLOG, entry, 'utf8');

    // Update state hash to include our own response
    const updated = await fsp.readFile(CHATLOG, 'utf8');
    await saveState({ lastHash: sha256(updated.replace(/\r\n/g, '\n')), lastProcessed: new Date().toISOString() });

    console.log(`[${PARTICIPANT_ID}] Response written (${response.length} chars)`);

  } catch (err) {
    console.error(`[${PARTICIPANT_ID}] error:`, err.message);
  } finally {
    processing = false;
  }
}

function scheduleProcess() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(processChange, DEBOUNCE_MS);
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
async function main() {
  await loadParticipantConfig();
  await loadRules();

  if (!fs.existsSync(CHATLOG)) {
    console.error(`[${PARTICIPANT_ID}] chatlog not found: ${CHATLOG}`);
    process.exit(1);
  }

  console.log(`[${PARTICIPANT_ID}] watching ${CHATLOG}`);
  console.log(`[${PARTICIPANT_ID}] respond-to: [${RESPOND_TO}]`);
  console.log(`[${PARTICIPANT_ID}] agent: ${AGENT_CMD}`);
  if (DRY_RUN) console.log(`[${PARTICIPANT_ID}] DRY RUN mode`);

  fs.watch(CHATLOG, { persistent: true }, scheduleProcess);

  // Process once on startup in case file already has unprocessed content
  processChange();
}

main().catch(err => { console.error(err); process.exit(1); });
