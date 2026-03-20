// Agentorum — home.js
// Vanilla JS client for the workspace home screen. No build step.

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let scenarios        = [];
let projects         = [];
let activeProject    = null;    // { id, name, ... } — project whose sessions panel is open
let sessions         = [];
let selectedScenario = null;    // id of selected scenario in new-project modal
let currentProjectId = null;    // projectId of the server's currently loaded session
let currentSessionId = null;    // sessionId of the server's currently loaded session

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
// Inline rename helper
// ---------------------------------------------------------------------------
function startRename({ currentName, onSave }) {
  const newName = window.prompt('New name:', currentName);
  if (!newName || !newName.trim() || newName.trim() === currentName) return;
  onSave(newName.trim()).catch(err => showError(err.message));
}

// ---------------------------------------------------------------------------
// Topbar: Resume button
// ---------------------------------------------------------------------------
function updateResumeButton() {
  const existing = document.getElementById('btn-resume-session');
  if (existing) existing.remove();

  if (!currentProjectId) return;

  const project = projects.find(p => p.id === currentProjectId);
  const label   = project ? project.name : 'Active Session';

  const btn = document.createElement('a');
  btn.id        = 'btn-resume-session';
  btn.href      = '/session';
  btn.className = 'btn-primary btn-sm';
  btn.textContent = `▶ Resume`;
  btn.title     = `Resume: ${label}`;

  document.getElementById('home-topbar-right').prepend(btn);
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
    const isActive = project.id === currentProjectId;
    card.className   = 'project-card' + (isActive ? ' project-card-active' : '');
    card.dataset.id  = project.id;

    const lastActive = formatRelative(project.lastActive);
    const sessionStr = project.sessionCount === 1 ? '1 session' : `${project.sessionCount} sessions`;
    const badge      = scenarioBadgeHtml(project.defaultScenario);
    const activePill = isActive ? `<span class="active-pill">● Active</span>` : '';
    // Active projects show a Resume action in the footer instead of + Session
    const footerAction = isActive
      ? `<a class="btn-resume-card btn-primary btn-sm" href="/session">▶ Resume</a>`
      : `<button class="btn-new-session-card btn-secondary btn-sm" data-project-id="${project.id}">+ Session</button>`;

    card.innerHTML = `
      <div class="project-card-header">
        ${badge}
        ${activePill}
        <button class="btn-delete-project btn-ghost btn-icon" title="Delete project" data-project-id="${project.id}">🗑</button>
      </div>
      <div class="project-card-body">
        <h3 class="project-name">
          ${escHtml(project.name)}
          <button class="btn-rename btn-ghost btn-icon" title="Rename project" data-type="project" data-id="${project.id}" data-current="${escHtml(project.name)}">✏</button>
        </h3>
        ${project.description ? `<p class="project-desc">${escHtml(project.description)}</p>` : ''}
      </div>
      <div class="project-card-footer">
        <span class="project-meta">${sessionStr}</span>
        ${lastActive ? `<span class="project-meta">${lastActive}</span>` : ''}
        ${footerAction}
      </div>
    `;

    // Click active card → go straight to the session (no intermediate panel)
    // Click other cards → open sessions panel
    card.addEventListener('click', (e) => {
      if (e.target.closest('.btn-new-session-card')) return;
      if (e.target.closest('.btn-delete-project')) return;
      if (e.target.closest('.btn-resume-card')) return; // <a> handles navigation
      if (e.target.closest('.btn-rename')) return;
      if (isActive) {
        window.location.href = '/session';
      } else {
        openSessionsPanel(project);
      }
    });

    // Rename button on project card
    card.querySelector('.btn-rename').addEventListener('click', (e) => {
      e.stopPropagation();
      const btn = e.currentTarget;
      startRename({
        currentName: btn.dataset.current,
        onSave: async (newName) => {
          await api(`/api/projects/${project.id}`, 'PATCH', { name: newName });
          project.name = newName;
          btn.dataset.current = newName;
          btn.closest('.project-name').firstChild.textContent = newName + ' ';
          updateResumeButton();
        }
      });
    });

    // "+ Session" button on card (only present for non-active projects)
    const newSessionBtn = card.querySelector('.btn-new-session-card');
    if (newSessionBtn) {
      newSessionBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openNewSessionModal(project);
      });
    }

    // Delete button on card
    card.querySelector('.btn-delete-project').addEventListener('click', (e) => {
      e.stopPropagation();
      confirmDeleteProject(project);
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

  // If there is only one session, open it directly — no extra click needed.
  if (sessions.length === 1) {
    openSession(project.id, sessions[0].id);
  }
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
    const isActiveSession = activeProject.id === currentProjectId && session.id === currentSessionId;
    row.className = 'session-row' + (isActiveSession ? ' session-row-active' : '');
    row.dataset.id = session.id;

    const lastActive  = formatRelative(session.lastActive);
    const entryStr    = session.entryCount === 1 ? '1 entry' : `${session.entryCount || 0} entries`;
    const badge       = scenarioBadgeHtml(session.scenario);
    const activePill  = isActiveSession ? `<span class="active-pill">● Active</span>` : '';
    const btnLabel    = isActiveSession ? 'Resume' : 'Open';

    row.innerHTML = `
      <div class="session-row-main">
        <div class="session-row-header">
          <span class="session-name">${escHtml(session.name)}</span>
          <button class="btn-rename btn-ghost btn-icon" title="Rename session" data-current="${escHtml(session.name)}">✏</button>
          ${badge}
          ${activePill}
        </div>
        <div class="session-row-meta">
          <span>${entryStr}</span>
          ${lastActive ? `<span>${lastActive}</span>` : ''}
        </div>
      </div>
      <button class="btn-open-session btn-primary btn-sm" data-project-id="${activeProject.id}" data-session-id="${session.id}">${btnLabel}</button>
    `;

    row.querySelector('.btn-open-session').addEventListener('click', () => {
      openSession(activeProject.id, session.id);
    });

    row.querySelector('.btn-rename').addEventListener('click', (e) => {
      e.stopPropagation();
      const btn = e.currentTarget;
      startRename({
        currentName: btn.dataset.current,
        onSave: async (newName) => {
          await api(`/api/sessions/${activeProject.id}/${session.id}`, 'PATCH', { name: newName });
          session.name = newName;
          btn.dataset.current = newName;
          btn.closest('.session-row-header').querySelector('.session-name').textContent = newName;
        }
      });
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
// Scenario manager
// ---------------------------------------------------------------------------
let editingScenarioId = null; // null = new, string = editing existing user scenario

document.getElementById('btn-manage-scenarios').addEventListener('click', () => {
  renderScenariosTable();
  showModal('modal-scenarios');
});

function renderScenariosTable() {
  const container = document.getElementById('scenarios-table');
  container.innerHTML = '';

  if (scenarios.length === 0) {
    container.innerHTML = '<p style="color:var(--text-muted);font-size:13px">No scenarios found.</p>';
    return;
  }

  const table = document.createElement('table');
  table.className = 'sc-table';
  table.innerHTML = `<thead><tr><th></th><th>ID</th><th>Name</th><th>Participants</th><th>Source</th><th></th></tr></thead>`;
  const tbody = document.createElement('tbody');

  for (const sc of scenarios) {
    const tr = document.createElement('tr');
    const participantCount = (sc.participants || []).length;
    const isUser = sc._source === 'user';
    tr.innerHTML = `
      <td>${sc.icon || ''}</td>
      <td><code>${escHtml(sc.id)}</code></td>
      <td>${escHtml(sc.name || sc.id)}</td>
      <td>${participantCount} participant${participantCount !== 1 ? 's' : ''}</td>
      <td><span class="sc-source-badge sc-source-${sc._source || 'builtin'}">${sc._source || 'builtin'}</span></td>
      <td class="sc-actions">
        ${isUser ? `<button class="btn-sc-edit btn-ghost btn-sm" data-id="${escHtml(sc.id)}">Edit</button>` : ''}
        ${isUser ? `<button class="btn-sc-delete btn-ghost btn-sm sc-delete" data-id="${escHtml(sc.id)}">Delete</button>` : ''}
      </td>
    `;
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  container.appendChild(table);

  container.querySelectorAll('.btn-sc-edit').forEach(btn => {
    btn.addEventListener('click', () => openScenarioEditor(scenarios.find(s => s.id === btn.dataset.id)));
  });
  container.querySelectorAll('.btn-sc-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(`Delete scenario "${btn.dataset.id}"? Projects using it will keep their existing config.`)) return;
      try {
        await api(`/api/scenarios/${btn.dataset.id}`, 'DELETE');
        scenarios = scenarios.filter(s => s.id !== btn.dataset.id);
        renderScenariosTable();
        showSuccess(`Scenario "${btn.dataset.id}" deleted.`);
      } catch (err) { showError(err.message || 'Delete failed'); }
    });
  });
}

document.getElementById('btn-new-scenario').addEventListener('click', () => openScenarioEditor(null));

function openScenarioEditor(scenario) {
  editingScenarioId = scenario ? scenario.id : null;
  document.getElementById('modal-scenario-edit-title').textContent =
    scenario ? `Edit Scenario: ${scenario.name || scenario.id}` : 'New Scenario';
  document.getElementById('sc-id').value          = scenario?.id          || '';
  document.getElementById('sc-id').disabled       = !!scenario; // can't change ID on edit
  document.getElementById('sc-name').value        = scenario?.name        || '';
  document.getElementById('sc-icon').value        = scenario?.icon        || '';
  document.getElementById('sc-description').value = scenario?.description || '';
  document.getElementById('sc-rules').value       = scenario?.sessionTemplate?.rules || '';

  // Render participant rows
  renderParticipantRows(scenario?.participants || [
    { id: 'HUMAN', label: 'Human', mode: 'human', role: '' }
  ]);

  closeModal('modal-scenarios');
  showModal('modal-scenario-edit');
  document.getElementById('sc-id').focus();
}

function renderParticipantRows(participants) {
  const container = document.getElementById('sc-participants');
  container.innerHTML = '';
  for (const p of participants) appendParticipantRow(p);
}

function appendParticipantRow(p = {}) {
  const container = document.getElementById('sc-participants');
  const row = document.createElement('div');
  row.className = 'sc-participant-row';
  row.innerHTML = `
    <input class="sc-p-id"   type="text" placeholder="ID (e.g. CLAUDE-DEV)" value="${escHtml(p.id || '')}">
    <input class="sc-p-label" type="text" placeholder="Display name"        value="${escHtml(p.label || '')}">
    <select class="sc-p-mode">
      <option value="human"       ${p.mode === 'human'       ? 'selected' : ''}>human</option>
      <option value="interactive" ${p.mode === 'interactive' ? 'selected' : ''}>interactive</option>
      <option value="watcher"     ${(!p.mode || p.mode === 'watcher') && p.mode !== 'human' && p.mode !== 'interactive' ? 'selected' : ''}>watcher</option>
    </select>
    <button class="btn-sc-remove-p btn-ghost btn-icon" title="Remove">✕</button>
  `;
  row.querySelector('.btn-sc-remove-p').addEventListener('click', () => row.remove());
  container.appendChild(row);
}

document.getElementById('btn-sc-add-participant').addEventListener('click', () => appendParticipantRow());

document.getElementById('btn-sc-save').addEventListener('click', async () => {
  const id   = document.getElementById('sc-id').value.trim();
  const name = document.getElementById('sc-name').value.trim();
  if (!id || !name) {
    showError('Scenario ID and name are required.');
    return;
  }

  const pRows = document.querySelectorAll('#sc-participants .sc-participant-row');
  const participants = Array.from(pRows).map(row => ({
    id:    row.querySelector('.sc-p-id').value.trim(),
    label: row.querySelector('.sc-p-label').value.trim(),
    mode:  row.querySelector('.sc-p-mode').value,
    role:  ''
  })).filter(p => p.id);

  const rulesText = document.getElementById('sc-rules').value.trim();
  const scenario = {
    id,
    name,
    icon:          document.getElementById('sc-icon').value.trim() || undefined,
    description:   document.getElementById('sc-description').value.trim() || undefined,
    participants,
    automationRules: [],
    sessionTemplate: rulesText ? { namePrefix: name, rules: rulesText } : { namePrefix: name }
  };

  try {
    await api('/api/scenarios', 'POST', scenario);
    // Refresh local list
    const fresh = await api('/api/scenarios').catch(() => null);
    if (fresh) scenarios = fresh;
    closeModal('modal-scenario-edit');
    showSuccess(`Scenario "${name}" saved.`);
  } catch (err) { showError(err.message || 'Save failed'); }
});

// ---------------------------------------------------------------------------
// Bundle loading
// ---------------------------------------------------------------------------

let successTimer = null;
function showSuccess(message) {
  const toast = document.getElementById('success-toast');
  toast.textContent = message;
  toast.style.display = 'block';
  clearTimeout(successTimer);
  successTimer = setTimeout(() => { toast.style.display = 'none'; }, 3000);
}

function showBundleError(message) {
  document.getElementById('bundle-error-message').textContent = message;
  showModal('modal-bundle-error');
}

async function loadBundleFromObject(bundle) {
  setLoading(true);
  try {
    const result = await api('/api/bundles/load', 'POST', bundle);
    if (result && result.redirectTo) {
      showSuccess('Session created from bundle — opening...');
      setTimeout(() => { window.location = result.redirectTo; }, 800);
    }
  } catch (err) {
    setLoading(false);
    showBundleError(err.message || 'Failed to load bundle');
  }
}

async function handleBundleFile(file) {
  if (!file || !file.name.endsWith('.json')) {
    showBundleError('Please select a .json bundle file.');
    return;
  }
  try {
    const text   = await file.text();
    const bundle = JSON.parse(text);
    await loadBundleFromObject(bundle);
  } catch (err) {
    showBundleError(`Invalid bundle format: ${err.message}`);
  }
}

// "Load Bundle" button → file picker
document.getElementById('btn-load-bundle').addEventListener('click', () => {
  document.getElementById('bundle-file-input').click();
});

document.getElementById('bundle-file-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = ''; // reset so same file can be re-selected
  if (file) handleBundleFile(file);
});

// Bundle error modal close via [data-close]
document.querySelectorAll('[data-close="modal-bundle-error"]').forEach(btn => {
  btn.addEventListener('click', () => closeModal('modal-bundle-error'));
});
document.getElementById('modal-bundle-error').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeModal('modal-bundle-error');
});

// Drag-and-drop onto the home screen
let _dragCounter = 0;
const dropOverlay = document.getElementById('bundle-drop-overlay');

document.addEventListener('dragenter', (e) => {
  // Only respond to file drags that include JSON
  const hasFiles = e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.includes('Files');
  if (!hasFiles) return;
  _dragCounter++;
  if (_dragCounter === 1) dropOverlay.style.display = 'flex';
});

document.addEventListener('dragleave', (e) => {
  _dragCounter--;
  if (_dragCounter <= 0) {
    _dragCounter = 0;
    dropOverlay.style.display = 'none';
  }
});

document.addEventListener('dragover', (e) => {
  e.preventDefault(); // required to allow drop
});

document.addEventListener('drop', (e) => {
  e.preventDefault();
  _dragCounter = 0;
  dropOverlay.style.display = 'none';

  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) handleBundleFile(file);
});

// ---------------------------------------------------------------------------
// Delete project
// ---------------------------------------------------------------------------
async function confirmDeleteProject(project) {
  // Block deletion of the currently active project with a clear message
  if (project.id === currentProjectId) {
    showError(`"${project.name}" is the active session. Open a different session first, then delete.`);
    return;
  }

  const sessionWord = project.sessionCount === 1 ? '1 session' : `${project.sessionCount} sessions`;
  if (!confirm(`Delete "${project.name}" and its ${sessionWord}?\n\nThis permanently removes the project folder and all chatlog data. This cannot be undone.`)) return;
  try {
    await api(`/api/projects/${project.id}`, 'DELETE');
    projects = projects.filter(p => p.id !== project.id);
    if (activeProject && activeProject.id === project.id) closeSessionsPanel();
    renderProjects();
    updateResumeButton();
    showSuccess(`"${project.name}" deleted.`);
  } catch { /* error shown by api() */ }
}

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

    // Read the server's currently loaded session so we can highlight it
    if (workspaceInfo && workspaceInfo.lastSession) {
      currentProjectId = workspaceInfo.lastSession.projectId || null;
      currentSessionId = workspaceInfo.lastSession.sessionId || null;
    }

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
    updateResumeButton();
  } finally {
    setLoading(false);
  }
}

init();

// When the browser restores this page from the back/forward cache (bfcache),
// the loading overlay may still be visible from the last navigation.  Reset it.
window.addEventListener('pageshow', (e) => {
  if (e.persisted) setLoading(false);
});
