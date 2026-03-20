// Agentorum — workspace.mjs
// WorkspaceManager: manages the ~/.agentorum/ workspace hierarchy.
// Workspace → Projects → Sessions, plus built-in and user Scenarios.

import path        from 'node:path';
import fs          from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os          from 'node:os';
import crypto      from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_WORKSPACE_DIR  = path.join(os.homedir(), '.agentorum');
const BUILTIN_SCENARIOS_DIR  = path.resolve(__dirname, '../../scenarios');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function slugify(name) {
  return name
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64) || 'untitled';
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

async function writeJson(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function safeReadDir(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter(e => e.isDirectory()).map(e => e.name);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Per-participant rules file generator
// ---------------------------------------------------------------------------
function buildParticipantRules({ participant, sharedRules, chatlogPath, rulesFilePath, token, port, sessionName }) {
  const now      = new Date().toISOString();
  const cont     = process.platform === 'win32' ? '^' : '\\';
  const curlCmd  = [
    `curl -X POST http://localhost:${port}/api/entries ${cont}`,
    `  -H "Content-Type: application/json" ${cont}`,
    `  -H "X-Agentorum-Token: ${token}" ${cont}`,
    `  -d "{\\"author\\":\\"${participant.id}\\",\\"body\\":\\"your finding here\\"}"`
  ].join('\n');

  return `# Agentorum Session Rules — ${participant.id}
# Session  : ${sessionName}
# Generated: ${now}

${sharedRules}

---

## Your Identity in This Session

Author ID    : ${participant.id}
Display Name : ${participant.label || participant.id}

---

## Reading the Chatlog

The shared chatlog is at:
  ${chatlogPath}

Reading strategy (minimise cost and context use):
1. If summary.md exists in the same folder, read it first for historical context.
2. Read only the LAST 50 entries of chatlog.md for recent context.
3. Avoid reading the full chatlog unless specifically required.

---

## Posting Your Findings

Do NOT write directly to chatlog.md. Post via the Agentorum API:

${curlCmd}

(On Linux/Mac use \\ instead of ^ for line continuation.)

If the server responds with {"error":"invalid_token"}, re-read this file to refresh your context.

---

## Initialisation

To connect your interactive session to this Agentorum session, paste the
following line into your agent's window:

  Read this file and confirm your role: ${rulesFilePath}
`;
}

// Count lines starting with '### ' as a proxy for entry count
async function countEntries(chatlogPath) {
  try {
    const raw = await fs.readFile(chatlogPath, 'utf8');
    return (raw.match(/^### /gm) || []).length;
  } catch {
    return 0;
  }
}

// Deep merge two objects. Arrays are merged by 'id' field when both sides
// have arrays of objects with id fields; otherwise the override wins.
function deepMerge(base, override) {
  if (override === undefined || override === null) return base;
  if (typeof base !== 'object' || typeof override !== 'object') return override;
  if (Array.isArray(base) && Array.isArray(override)) {
    // If elements have id fields, merge by id
    if (base.length > 0 && base[0] && typeof base[0] === 'object' && 'id' in base[0]) {
      const merged = base.map(item => {
        const match = override.find(o => o.id === item.id);
        if (!match) return item;
        return { ...item, ...match };
      });
      // Append override items that don't exist in base
      for (const o of override) {
        if (!base.find(b => b.id === o.id)) merged.push(o);
      }
      return merged;
    }
    return override;
  }
  const result = { ...base };
  for (const key of Object.keys(override)) {
    if (override[key] !== undefined) {
      result[key] = deepMerge(base[key], override[key]);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// WorkspaceManager
// ---------------------------------------------------------------------------
export class WorkspaceManager {
  constructor(workspaceDir = DEFAULT_WORKSPACE_DIR) {
    this.workspaceDir   = workspaceDir;
    this.projectsDir    = path.join(workspaceDir, 'projects');
    this.scenariosDir   = path.join(workspaceDir, 'scenarios');
    this.workspaceFile  = path.join(workspaceDir, 'workspace.json');
  }

  // -------------------------------------------------------------------------
  // Initialise workspace directory structure
  // -------------------------------------------------------------------------
  async init() {
    await ensureDir(this.workspaceDir);
    await ensureDir(this.projectsDir);
    await ensureDir(this.scenariosDir);

    if (!existsSync(this.workspaceFile)) {
      await writeJson(this.workspaceFile, {
        name:    'My Agentorum Workspace',
        created: new Date().toISOString(),
        version: 1
      });
    }
  }

  // -------------------------------------------------------------------------
  // Scenarios
  // -------------------------------------------------------------------------
  async listScenarios() {
    const scenarioMap = new Map();

    // Load built-in scenarios first
    const builtinFiles = await fs.readdir(BUILTIN_SCENARIOS_DIR).catch(() => []);
    for (const file of builtinFiles) {
      if (!file.endsWith('.scenario.json')) continue;
      try {
        const scenario = await readJson(path.join(BUILTIN_SCENARIOS_DIR, file));
        scenarioMap.set(scenario.id, { ...scenario, _source: 'builtin' });
      } catch { /* skip malformed */ }
    }

    // Load user scenarios — these override built-ins with the same id
    const userFiles = await fs.readdir(this.scenariosDir).catch(() => []);
    for (const file of userFiles) {
      if (!file.endsWith('.scenario.json')) continue;
      try {
        const scenario = await readJson(path.join(this.scenariosDir, file));
        scenarioMap.set(scenario.id, { ...scenario, _source: 'user' });
      } catch { /* skip malformed */ }
    }

    return Array.from(scenarioMap.values());
  }

  async loadScenario(id) {
    const scenarios = await this.listScenarios();
    const scenario  = scenarios.find(s => s.id === id);
    if (!scenario) throw new Error(`Scenario not found: ${id}`);
    return scenario;
  }

  // -------------------------------------------------------------------------
  // Projects
  // -------------------------------------------------------------------------
  async listProjects() {
    const ids = await safeReadDir(this.projectsDir);
    const projects = [];

    for (const id of ids) {
      try {
        const project = await this.getProject(id);
        projects.push(project);
      } catch { /* skip malformed */ }
    }

    // Sort by lastActive descending
    return projects.sort((a, b) => {
      const ta = a.lastActive || a.created || '';
      const tb = b.lastActive || b.created || '';
      return tb.localeCompare(ta);
    });
  }

  async createProject({ name, description = '', defaultScenario = 'vc-debate', bundleId = null }) {
    if (!name || !name.trim()) throw new Error('Project name is required');

    let id   = slugify(name);
    let slot = 2;
    while (existsSync(path.join(this.projectsDir, id))) {
      id = `${slugify(name)}-${slot++}`;
    }

    const projectDir  = path.join(this.projectsDir, id);
    const sessionsDir = path.join(projectDir, 'sessions');
    await ensureDir(projectDir);
    await ensureDir(sessionsDir);

    const now     = new Date().toISOString();
    const project = {
      id,
      name:            name.trim(),
      description:     description.trim(),
      defaultScenario,
      bundleId:        bundleId || null,
      created:         now,
      lastActive:      now,
      overrides:       {}
    };

    await writeJson(path.join(projectDir, 'project.json'), project);
    return project;
  }

  // Find an existing project that was created from a specific bundle.
  async findProjectByBundleId(bundleId) {
    const ids = await safeReadDir(this.projectsDir);
    for (const id of ids) {
      try {
        const data = await readJson(path.join(this.projectsDir, id, 'project.json'));
        if (data.bundleId === bundleId) return { ...data, id };
      } catch { /* skip malformed */ }
    }
    return null;
  }

  async deleteProject(projectId) {
    const projectDir = path.join(this.projectsDir, projectId);
    // Verify it exists (throws if project.json is missing)
    await readJson(path.join(projectDir, 'project.json'));
    // Delete the entire project directory tree
    await fs.rm(projectDir, { recursive: true, force: true });
    // Clear lastSession if it pointed to this project
    try {
      const info = await readJson(this.workspaceFile);
      if (info.lastSession && info.lastSession.projectId === projectId) {
        delete info.lastSession;
        await writeJson(this.workspaceFile, info);
      }
    } catch { /* ignore — non-fatal */ }
  }

  async getProject(projectId) {
    const projectDir = path.join(this.projectsDir, projectId);
    const data       = await readJson(path.join(projectDir, 'project.json'));

    // Count sessions
    const sessionIds    = await safeReadDir(path.join(projectDir, 'sessions'));
    const sessionCount  = sessionIds.length;

    // Derive lastActive from sessions if needed
    let lastActive = data.lastActive || data.created;
    for (const sid of sessionIds) {
      try {
        const sess = await readJson(path.join(projectDir, 'sessions', sid, 'session.json'));
        if (sess.lastActive && sess.lastActive > lastActive) lastActive = sess.lastActive;
      } catch { /* ignore */ }
    }

    return { ...data, id: projectId, sessionCount, lastActive };
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------
  async listSessions(projectId) {
    const sessionsDir = path.join(this.projectsDir, projectId, 'sessions');
    const ids         = await safeReadDir(sessionsDir);
    const sessions    = [];

    for (const id of ids) {
      try {
        const sessionDir  = path.join(sessionsDir, id);
        const data        = await readJson(path.join(sessionDir, 'session.json'));
        const entryCount  = await countEntries(path.join(sessionDir, 'chatlog.md'));
        sessions.push({ ...data, id, entryCount });
      } catch { /* skip malformed */ }
    }

    // Sort by lastActive descending
    return sessions.sort((a, b) => {
      const ta = a.lastActive || a.created || '';
      const tb = b.lastActive || b.created || '';
      return tb.localeCompare(ta);
    });
  }

  async createSession(projectId, { name, scenario: scenarioId, overrides = {} }) {
    if (!name || !name.trim()) throw new Error('Session name is required');

    // Load project
    const project     = await this.getProject(projectId);
    const resolvedId  = scenarioId || project.defaultScenario || 'vc-debate';

    // Load scenario
    const scenario = await this.loadScenario(resolvedId);

    // Resolve config via deep merge
    const resolvedConfig = await this.resolveConfig(scenario, project.overrides || {}, overrides);

    // Generate session id
    const sessionsDir = path.join(this.projectsDir, projectId, 'sessions');
    let id   = slugify(name);
    let slot = 2;
    while (existsSync(path.join(sessionsDir, id))) {
      id = `${slugify(name)}-${slot++}`;
    }

    const sessionDir = path.join(sessionsDir, id);
    await ensureDir(sessionDir);

    const now        = new Date().toISOString();
    const chatlogPath  = path.join(sessionDir, 'chatlog.md');
    const configPath   = path.join(sessionDir, 'agentorum.config.json');

    // Write session.json
    const sessionMeta = {
      id,
      name:        name.trim(),
      scenario:    resolvedId,
      created:     now,
      lastActive:  now,
      overrides
    };
    await writeJson(path.join(sessionDir, 'session.json'), sessionMeta);

    // Write initial chatlog — use an HTML comment so it is invisible in rendered
    // Markdown and does NOT match the ### TIMESTAMP - AUTHOR entry pattern.
    const systemEntry = `<!-- agentorum: session="${name.trim()}" scenario="${scenario.name}" created="${now}" -->\n\n`;
    await fs.writeFile(chatlogPath, systemEntry, 'utf8');

    // Write agentorum.config.json for this session
    const sessionConfig = {
      ...resolvedConfig,
      chatlog: chatlogPath,
      port:    3737
    };
    await writeJson(configPath, sessionConfig);

    return { sessionId: id, configPath, chatlogPath };
  }

  async getSession(projectId, sessionId) {
    const sessionDir = path.join(this.projectsDir, projectId, 'sessions', sessionId);
    const data       = await readJson(path.join(sessionDir, 'session.json'));
    return { ...data, id: sessionId };
  }

  async updateSessionLastActive(projectId, sessionId) {
    const sessionDir  = path.join(this.projectsDir, projectId, 'sessions', sessionId);
    const sessionFile = path.join(sessionDir, 'session.json');
    const data        = await readJson(sessionFile);
    data.lastActive   = new Date().toISOString();
    await writeJson(sessionFile, data);

    // Also bubble up to project
    const projectFile = path.join(this.projectsDir, projectId, 'project.json');
    try {
      const proj = await readJson(projectFile);
      proj.lastActive = data.lastActive;
      await writeJson(projectFile, proj);
    } catch { /* ignore */ }
  }

  // -------------------------------------------------------------------------
  // Config resolution
  // -------------------------------------------------------------------------
  async resolveConfig(scenario, projectOverrides = {}, sessionOverrides = {}) {
    // Start from scenario as base, deep-merge project overrides, then session overrides
    let config = { ...scenario };

    // Remove scenario-specific metadata fields that don't belong in the config
    delete config._source;

    if (projectOverrides && Object.keys(projectOverrides).length > 0) {
      config = deepMerge(config, projectOverrides);
    }
    if (sessionOverrides && Object.keys(sessionOverrides).length > 0) {
      config = deepMerge(config, sessionOverrides);
    }

    return config;
  }

  // -------------------------------------------------------------------------
  // Bundle loading
  // -------------------------------------------------------------------------

  /**
   * Load a bundle from a file path.
   * Reads and parses the JSON, then delegates to loadBundleFromObject.
   */
  async loadBundle(bundlePath) {
    const raw    = await fs.readFile(bundlePath, 'utf8');
    const bundle = JSON.parse(raw);
    return this.loadBundleFromObject(bundle);
  }

  /**
   * Load a bundle from an already-parsed object.
   * Validates the bundle, registers the scenario, creates a project and session,
   * and appends the initialEntry to the chatlog.
   * Returns { projectId, sessionId, configPath, chatlogPath, sessionName }.
   */
  async loadBundleFromObject(bundle) {
    // Validate
    if (!bundle || typeof bundle !== 'object') {
      throw new Error('Invalid bundle: expected a JSON object');
    }
    if (bundle.bundleVersion === undefined || bundle.bundleVersion === null) {
      throw new Error('Invalid bundle format: missing bundleVersion field');
    }
    if (bundle.bundleVersion !== 1) {
      throw new Error(`Unsupported bundleVersion: ${bundle.bundleVersion} (expected 1)`);
    }
    if (!bundle.id) {
      throw new Error('Invalid bundle format: missing id field');
    }
    if (!bundle.scenario || typeof bundle.scenario !== 'object') {
      throw new Error('Invalid bundle format: missing scenario field');
    }
    if (!bundle.project || typeof bundle.project !== 'object') {
      throw new Error('Invalid bundle format: missing project field');
    }

    // Register the scenario into ~/.agentorum/scenarios/<id>.scenario.json
    const scenarioFileName = `${bundle.id}.scenario.json`;
    const scenarioFilePath = path.join(this.scenariosDir, scenarioFileName);
    await writeJson(scenarioFilePath, bundle.scenario);

    // Reuse an existing project for this bundle if one exists, otherwise create a new one.
    const projectName        = (bundle.project.name || bundle.name || bundle.id).trim();
    const projectDescription = (bundle.project.description || bundle.description || '').trim();
    let project = await this.findProjectByBundleId(bundle.id);
    if (!project) {
      project = await this.createProject({
        name:            projectName,
        description:     projectDescription,
        defaultScenario: bundle.scenario.id,
        bundleId:        bundle.id
      });
    }

    // Derive session name: namePrefix + today's date
    const today       = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const namePrefix  = (bundle.sessionTemplate && bundle.sessionTemplate.namePrefix)
      ? bundle.sessionTemplate.namePrefix
      : 'Session';
    const sessionName = `${namePrefix} ${today}`;

    // Check for an existing session with the same name (i.e. today's session for this project).
    // If found, resume it instead of creating a duplicate.
    const sessionsDir = path.join(this.projectsDir, project.id, 'sessions');
    const existingSessionIds = await safeReadDir(sessionsDir);
    for (const sid of existingSessionIds) {
      try {
        const sess = await readJson(path.join(sessionsDir, sid, 'session.json'));
        if (sess.name === sessionName) {
          // Resume existing session — return its paths without modification.
          const sessionDir  = path.join(sessionsDir, sid);
          const configPath  = path.join(sessionDir, 'agentorum.config.json');
          const chatlogPath = path.join(sessionDir, 'chatlog.md');
          console.log(`[agentorum] resuming existing session "${sess.name}" (${sid})`);
          return { projectId: project.id, sessionId: sid, configPath, chatlogPath, sessionName };
        }
      } catch { /* skip malformed */ }
    }

    // No matching session found — create a fresh one for today.
    const { sessionId, configPath, chatlogPath } = await this.createSession(project.id, {
      name:      sessionName,
      scenario:  bundle.scenario.id,
      overrides: {}
    });

    const sessionDir = path.dirname(configPath);

    // Generate session token and store in session.json
    const sessionToken = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    const sessionFilePath = path.join(sessionDir, 'session.json');
    const sessionData = JSON.parse(await fs.readFile(sessionFilePath, 'utf8'));
    sessionData.token = sessionToken;
    await writeJson(sessionFilePath, sessionData);

    // Write shared rules.txt from bundle if provided, and reference it in the config
    const sharedRules = bundle.sessionTemplate?.rules || '';
    if (sharedRules) {
      const rulesPath = path.join(sessionDir, 'rules.txt');
      await fs.writeFile(rulesPath, sharedRules, 'utf8');
      // Patch the resolved config to reference rules.txt
      const cfg = JSON.parse(await fs.readFile(configPath, 'utf8'));
      cfg.rules = 'rules.txt';
      await writeJson(configPath, cfg);
    }

    // Generate per-participant rules files for interactive participants
    const port = 3737;
    const interactiveParticipants = (bundle.scenario.participants || [])
      .filter(p => p.mode === 'interactive');
    for (const p of interactiveParticipants) {
      const rulesFileName = `rules-${p.id}.txt`;
      const rulesFilePath = path.join(sessionDir, rulesFileName);
      const content = buildParticipantRules({
        participant: p,
        sharedRules,
        chatlogPath,
        rulesFilePath,
        token: sessionToken,
        port,
        sessionName
      });
      await fs.writeFile(rulesFilePath, content, 'utf8');
    }

    // Append the initialEntry if defined
    if (
      bundle.sessionTemplate &&
      bundle.sessionTemplate.initialEntry &&
      typeof bundle.sessionTemplate.initialEntry.body === 'string'
    ) {
      const entry   = bundle.sessionTemplate.initialEntry;
      const author  = entry.author || 'HUMAN';
      const body    = entry.body;
      const ts      = new Date().toISOString().replace('T', ' ').slice(0, 19);
      const entryText = `### ${ts} - ${author}\n\n${body}\n\n`;
      await fs.appendFile(chatlogPath, entryText, 'utf8');
    }

    return { projectId: project.id, sessionId, configPath, chatlogPath, sessionName };
  }

  // -------------------------------------------------------------------------
  // Last-active session persistence
  // Stored in workspace.json so plain `node server.mjs` restores where the
  // user left off, without needing to re-pass --bundle or --config.
  // -------------------------------------------------------------------------
  async getLastActiveSession() {
    try {
      const info = await readJson(this.workspaceFile);
      const last = info.lastSession;
      if (!last || !last.projectId || !last.sessionId) return null;
      // Verify the session directory still exists before returning it.
      const configPath = path.join(
        this.projectsDir, last.projectId, 'sessions', last.sessionId, 'agentorum.config.json'
      );
      if (!existsSync(configPath)) return null;
      return { projectId: last.projectId, sessionId: last.sessionId, configPath };
    } catch {
      return null;
    }
  }

  async saveLastActiveSession(projectId, sessionId) {
    try {
      let info = {};
      try { info = await readJson(this.workspaceFile); } catch { /* first write */ }
      info.lastSession = { projectId, sessionId };
      await writeJson(this.workspaceFile, info);
    } catch { /* non-fatal — workspace.json write failure should not crash server */ }
  }

  // -------------------------------------------------------------------------
  // Workspace info
  // -------------------------------------------------------------------------
  async getWorkspaceInfo() {
    let info = {};
    try {
      info = await readJson(this.workspaceFile);
    } catch { /* workspace.json missing — return defaults */ }

    const projectIds    = await safeReadDir(this.projectsDir);
    const scenarios     = await this.listScenarios();

    return {
      ...info,
      workspaceDir:   this.workspaceDir,
      projectCount:   projectIds.length,
      scenarioCount:  scenarios.length
    };
  }
}
