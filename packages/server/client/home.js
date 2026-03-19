// Agentorum — home.js
// Vanilla JS client for the workspace home screen. No build step.

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let scenarios        = [];
let projects         = [];
let activeProject    = null;    // { id, name, ... }
let sessions         = [];
let selectedScenario = null;    // id of selected scenario in new-project modal

// ---------------------------------------------------------------------------
// API helper
// ---------------------------------------------------------------------------
async function api(urlPath, method = 'GET', body = null) {
  const opts = { method, headers: {} };
  if (body) {
    opts.body = JSON.stringify(body);
    opts.headers['Content-Type'] = 'application/json';
  }
  try {
    const res = await fetch(urlPath, opts);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    return res.json();
  } catch (err) {
    showError(err.message);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Error toast
// ---------------------------------------------------------------------------
let errorTimer = null;
function showError(message) {
  const toast = document.getElementById('error-toast');
  toast.textContent = message;
  toast.style.display = 'block';
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => { toast.style.display = 'none'; }, 5000);
}

// ---------------------------------------------------------------------------
// Loading overlay
// ---------------------------------------------------------------------------
function setLoading(on) {
  document.getElementById('loading-overlay').style.display = on ? 'flex' : 'none';
}

// ---------------------------------------------------------------------------
// Scenario helpers
// ---------------------------------------------------------------------------
const SCENARIO_COLORS = {
  'vc-debate':        '#16a34a',
  'policy-mediation': '#7c3aed',
  'code-review':      '#E63946',
};

function scenarioColor(id) {
  return SCENARIO_COLORS[id] || '#2563eb';
}

function scenarioBadgeHtml(scenarioId) {
  const scenario = scenarios.find(s => s.id === scenarioId);
  const name     = scenario ? scenario.name : scenarioId;
  const icon     = scenario ? (scenario.icon || '') : '';
  const color    = scenarioColor(scenarioId);
  return `<span class="scenario-badge" style="--badge-color:${color}">${icon ? icon + ' ' : ''}${name}</span>`;
}

// ---------------------------------------------------------------------------
// Date formatting
// ---------------------------------------------------------------------------
function formatRelative(isoStr) {
  if (!isoStr) return '';
  const diff = Math.floor((Date.now() - new Date(isoStr)) / 1000);
  if (diff < 60)    return 'just now';
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 2592000) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(isoStr).toLocaleDateString();
}

// ---------------------------------------------------------------------------
// Render projects
// ---------------------------------------------------------------------------
function renderProjects() {
  const grid  = document.getElementById('projects-grid');
  const empty = document.getElementById('empty-state');

  grid.innerHTML = '';

  if (projects.length === 0) {
    empty.style.display = 'flex';
    grid.style.display  = 'none';
    return;
  }

  empty.style.display = 'none';
  grid.style.display  = 'grid';

  for (const project of projects) {
    const card = document.createElement('div');
    card.className   = 'project-card';
    card.dataset.id  = project.id;

    const lastActive = formatRelative(project.lastActive);
    const sessionStr = project.sessionCount === 1 ? '1 session' : `${project.sessionCount} sessions`;
    const badge      = scenarioBadgeHtml(project.defaultScenario);

    card.innerHTML = `
      <div class="project-card-header">
        ${badge}
      </div>
      <div class="project-card-body">
        <h3 class="project-name">${escHtml(project.name)}</h3>
        ${project.description ? `<p class="project-desc">${escHtml(project.description)}</p>` : ''}
      </div>
      <div class="project-card-footer">
        <span class="project-meta">${sessionStr}</span>
        ${lastActive ? `<span class="project-meta">${lastActive}</span>` : ''}
        <button class="btn-new-session-card btn-secondary btn-sm" data-project-id="${project.id}">+ Session</button>
      </div>
    `;

    // Click card body to open sessions panel (not the "+ Session" button)
    card.addEventListener('click', (e) => {
      if (e.target.closest('.btn-new-session-card')) return;
      openSessionsPanel(project);
    });

    // "+ Session" button on card
    card.querySelector('.btn-new-session-card').addEventListener('click', (e) => {
      e.stopPropagation();
      openNewSessionModal(project);
    });

    grid.appendChild(card);
  }
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Sessions panel
// ---------------------------------------------------------------------------
async function openSessionsPanel(project) {
  activeProject = project;

  document.getElementById('sessions-project-name').textContent = project.name;
  document.getElementById('sessions-project-scenario').outerHTML =
    `<span id="sessions-project-scenario">${scenarioBadgeHtml(project.defaultScenario)}</span>`;

  const panel = document.getElementById('sessions-panel');
  panel.classList.remove('panel-hidden');
  panel.classList.add('panel-visible');

  await loadSessions(project.id);
}

function closeSessionsPanel() {
  activeProject = null;
  const panel = document.getElementById('sessions-panel');
  panel.classList.remove('panel-visible');
  panel.classList.add('panel-hidden');
}

async function loadSessions(projectId) {
  try {
    sessions = await api(`/api/projects/${projectId}/sessions`);
    renderSessions();
  } catch {
    // error shown by api()
  }
}

function renderSessions() {
  const list  = document.getElementById('sessions-list');
  const empty = document.getElementById('sessions-empty');
  list.innerHTML = '';

  if (sessions.length === 0) {
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  for (const session of sessions) {
    const row = document.createElement('div');
    row.className = 'session-row';
    row.dataset.id = session.id;

    const lastActive  = formatRelative(session.lastActive);
    const entryStr    = session.entryCount === 1 ? '1 entry' : `${session.entryCount || 0} entries`;
    const badge       = scenarioBadgeHtml(session.scenario);

    row.innerHTML = `
      <div class="session-row-main">
        <div class="session-row-header">
          <span class="session-name">${escHtml(session.name)}</span>
          ${badge}
        </div>
        <div class="session-row-meta">
          <span>${entryStr}</span>
          ${lastActive ? `<span>${lastActive}</span>` : ''}
        </div>
      </div>
      <button class="btn-open-session btn-primary btn-sm" data-project-id="${activeProject.id}" data-session-id="${session.id}">Open</button>
    `;

    row.querySelector('.btn-open-session').addEventListener('click', () => {
      openSession(activeProject.id, session.id);
    });

    list.appendChild(row);
  }
}

async function openSession(projectId, sessionId) {
  setLoading(true);
  try {
    const result = await api(`/api/sessions/${projectId}/${sessionId}/open`, 'POST');
    if (result && result.redirectTo) {
      window.location.href = result.redirectTo;
    }
  } catch {
    setLoading(false);
  }
}

// ---------------------------------------------------------------------------
// New Project modal
// ---------------------------------------------------------------------------
function openNewProjectModal() {
  document.getElementById('proj-name').value = '';
  document.getElementById('proj-description').value = '';
  selectedScenario = scenarios.length > 0 ? scenarios[0].id : null;
  renderScenarioCards();
  showModal('modal-project');
  document.getElementById('proj-name').focus();
}

function renderScenarioCards() {
  const container = document.getElementById('scenario-cards');
  container.innerHTML = '';

  for (const scenario of scenarios) {
    const card = document.createElement('div');
    card.className = 'scenario-card' + (scenario.id === selectedScenario ? ' selected' : '');
    card.dataset.id = scenario.id;

    const color = scenarioColor(scenario.id);
    card.innerHTML = `
      <div class="scenario-card-icon" style="background:${color}22;color:${color}">${scenario.icon || '⬡'}</div>
      <div class="scenario-card-text">
        <div class="scenario-card-name">${escHtml(scenario.name)}</div>
        <div class="scenario-card-desc">${escHtml(scenario.description || '')}</div>
      </div>
    `;
    card.addEventListener('click', () => {
      selectedScenario = scenario.id;
      container.querySelectorAll('.scenario-card').forEach(c => {
        c.classList.toggle('selected', c.dataset.id === selectedScenario);
      });
    });
    container.appendChild(card);
  }
}

async function createProject() {
  const name        = document.getElementById('proj-name').value.trim();
  const description = document.getElementById('proj-description').value.trim();
  const defaultScenario = selectedScenario || 'vc-debate';

  if (!name) {
    document.getElementById('proj-name').focus();
    return;
  }

  const btn = document.getElementById('btn-create-project');
  btn.disabled = true;
  btn.textContent = 'Creating…';

  try {
    const project = await api('/api/projects', 'POST', { name, description, defaultScenario });
    closeModal('modal-project');
    projects.unshift(project);
    renderProjects();
    openSessionsPanel(project);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create Project';
  }
}

// ---------------------------------------------------------------------------
// New Session modal
// ---------------------------------------------------------------------------
function openNewSessionModal(project) {
  activeProject = project;
  document.getElementById('sess-name').value = '';
  document.getElementById('sess-scenario').value = '';
  document.getElementById('sess-project-label').textContent =
    `Project: ${project.name}  •  Default scenario: ${scenarios.find(s => s.id === project.defaultScenario)?.name || project.defaultScenario}`;
  showModal('modal-session');
  document.getElementById('sess-name').focus();
}

async function createSession() {
  const name     = document.getElementById('sess-name').value.trim();
  const scenario = document.getElementById('sess-scenario').value || undefined;

  if (!name) {
    document.getElementById('sess-name').focus();
    return;
  }
  if (!activeProject) return;

  const btn = document.getElementById('btn-create-session');
  btn.disabled = true;
  btn.textContent = 'Creating…';

  try {
    const result = await api(`/api/projects/${activeProject.id}/sessions`, 'POST', {
      name,
      scenario,
      overrides: {}
    });
    closeModal('modal-session');

    // Immediately open the session
    if (result && result.sessionId) {
      await openSession(activeProject.id, result.sessionId);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create & Open';
  }
}

// ---------------------------------------------------------------------------
// Modal helpers
// ---------------------------------------------------------------------------
function showModal(id) {
  const el = document.getElementById(id);
  el.style.display = 'flex';
  el.setAttribute('aria-hidden', 'false');
}

function closeModal(id) {
  const el = document.getElementById(id);
  el.style.display = 'none';
  el.setAttribute('aria-hidden', 'true');
}

// Close modal on backdrop click
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal(overlay.id);
  });
});

// Close modal via [data-close] buttons
document.querySelectorAll('[data-close]').forEach(btn => {
  btn.addEventListener('click', () => closeModal(btn.dataset.close));
});

// Close modals on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay').forEach(m => {
      if (m.style.display !== 'none') closeModal(m.id);
    });
    closeSessionsPanel();
  }
});

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------
document.getElementById('btn-new-project').addEventListener('click', openNewProjectModal);
document.getElementById('btn-empty-new-project').addEventListener('click', openNewProjectModal);
document.getElementById('btn-create-project').addEventListener('click', createProject);
document.getElementById('btn-create-session').addEventListener('click', createSession);
document.getElementById('btn-close-sessions').addEventListener('click', closeSessionsPanel);
document.getElementById('btn-new-session').addEventListener('click', () => {
  if (activeProject) openNewSessionModal(activeProject);
});

// Enter key in name fields submits
document.getElementById('proj-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') createProject();
});
document.getElementById('sess-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') createSession();
});

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------
async function init() {
  setLoading(true);
  try {
    // Parallel fetch: workspace info, scenarios, projects
    const [workspaceInfo, scenariosData, projectsData] = await Promise.all([
      api('/api/workspace').catch(() => ({})),
      api('/api/scenarios').catch(() => []),
      api('/api/projects').catch(() => []),
    ]);

    scenarios = scenariosData || [];
    projects  = projectsData  || [];

    // Set workspace name in topbar
    if (workspaceInfo && workspaceInfo.name) {
      document.getElementById('workspace-name').textContent = workspaceInfo.name;
    }

    // Populate scenario selector in new-session modal
    const sessScenarioSel = document.getElementById('sess-scenario');
    for (const s of scenarios) {
      const opt = document.createElement('option');
      opt.value       = s.id;
      opt.textContent = `${s.icon || ''} ${s.name}`.trim();
      sessScenarioSel.appendChild(opt);
    }

    // Default selected scenario
    if (scenarios.length > 0) selectedScenario = scenarios[0].id;

    renderProjects();
  } finally {
    setLoading(false);
  }
}

init();
