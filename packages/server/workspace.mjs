// Agentorum — workspace.mjs
// WorkspaceManager: manages the ~/.agentorum/ workspace hierarchy.
// Workspace → Projects → Sessions, plus built-in and user Scenarios.

import path        from 'node:path';
import fs          from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os          from 'node:os';
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

  async createProject({ name, description = '', defaultScenario = 'vc-debate' }) {
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
      created:         now,
      lastActive:      now,
      overrides:       {}
    };

    await writeJson(path.join(projectDir, 'project.json'), project);
    return project;
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

    // Write initial chatlog
    const systemEntry = `### ${now.replace('T', ' ').slice(0, 19)} - SYSTEM\n\nSession "${name.trim()}" started. Scenario: ${scenario.name}.\n\n`;
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
