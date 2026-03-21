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
// Bulk cleanup
// ---------------------------------------------------------------------------
function updateCleanupButton() {
  const btn      = document.getElementById('btn-cleanup-projects');
  const inactive = projects.filter(p => p.id !== currentProjectId);
  btn.style.display = inactive.length > 1 ? 'inline-flex' : 'none';
  btn.textContent   = `🧹 Clean up ${inactive.length} inactive`;
}

document.getElementById('btn-cleanup-projects').addEventListener('click', async () => {
  const inactive = projects.filter(p => p.id !== currentProjectId);
  if (inactive.length === 0) return;
  if (!confirm(`Delete ${inactive.length} inactive project${inactive.length !== 1 ? 's' : ''}?\n\nThis permanently removes their folders and all chatlog data. Cannot be undone.`)) return;

  let deleted = 0;
  for (const p of inactive) {
    try {
      await api(`/api/projects/${p.id}`, 'DELETE');
      deleted++;
    } catch { /* skip — error toast shown by api() */ }
  }
  projects = projects.filter(p => p.id === currentProjectId);
  renderProjects();
  updateResumeButton();
  updateCleanupButton();
  showSuccess(`Deleted ${deleted} inactive project${deleted !== 1 ? 's' : ''}.`);
});

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
  // Clear cross-session search
  document.getElementById('sessions-search').value = '';
  document.getElementById('sessions-search-results').style.display = 'none';
  document.getElementById('sessions-list').style.display = '';
}

async function loadSessions(projectId) {
  try {
    sessions = await api(`/api/projects/${projectId}/sessions`);
    renderSessions();
  } catch {
    // error shown by api()
  }
}

let showArchived = false;

function renderSessions() {
  const list  = document.getElementById('sessions-list');
  const empty = document.getElementById('sessions-empty');
  list.innerHTML = '';

  const active   = sessions.filter(s => !s.archived);
  const archived = sessions.filter(s =>  s.archived);
  const visible  = showArchived ? sessions : active;

  if (visible.length === 0 && !showArchived) {
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  for (const session of visible) {
    const row = document.createElement('div');
    const isActiveSession = activeProject.id === currentProjectId && session.id === currentSessionId;
    const isArchived = !!session.archived;
    row.className = 'session-row' + (isActiveSession ? ' session-row-active' : '') + (isArchived ? ' session-row-archived' : '');
    row.dataset.id = session.id;

    const lastActive  = formatRelative(session.lastActive);
    const entryStr    = session.entryCount === 1 ? '1 entry' : `${session.entryCount || 0} entries`;
    const badge       = scenarioBadgeHtml(session.scenario);
    const activePill  = isActiveSession ? `<span class="active-pill">● Active</span>` : '';
    const archivePill = isArchived ? `<span class="archived-pill">Archived</span>` : '';
    const btnLabel    = isActiveSession ? 'Resume' : 'Open';
    const archiveBtnLabel = isArchived ? '↩ Unarchive' : '🗂';
    const archiveBtnTitle = isArchived ? 'Unarchive session' : 'Archive session';

    const descHtml = session.description
      ? `<div class="session-description">${escHtml(session.description)}</div>`
      : `<div class="session-description session-description-empty">Add notes…</div>`;

    row.innerHTML = `
      <div class="session-row-main">
        <div class="session-row-header">
          <span class="session-name">${escHtml(session.name)}</span>
          <button class="btn-rename btn-ghost btn-icon" title="Rename session" data-current="${escHtml(session.name)}">✏</button>
          ${badge}
          ${activePill}
          ${archivePill}
        </div>
        <div class="session-row-meta">
          <span>${entryStr}</span>
          ${lastActive ? `<span>${lastActive}</span>` : ''}
        </div>
        ${descHtml}
      </div>
      <div class="session-row-actions">
        ${!isActiveSession ? `<button class="btn-archive-session btn-ghost btn-icon" title="${archiveBtnTitle}" data-archived="${isArchived}">${archiveBtnLabel}</button>` : ''}
        <button class="btn-open-session btn-primary btn-sm" data-project-id="${activeProject.id}" data-session-id="${session.id}">${btnLabel}</button>
      </div>
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

    row.querySelector('.session-description').addEventListener('click', (e) => {
      e.stopPropagation();
      const descEl = e.currentTarget;
      const current = session.description || '';
      const input = document.createElement('textarea');
      input.className = 'session-description-input';
      input.value = current;
      input.placeholder = 'Session notes…';
      input.rows = 2;
      descEl.replaceWith(input);
      input.focus();
      const save = async () => {
        const val = input.value.trim();
        await api(`/api/sessions/${activeProject.id}/${session.id}/description`, 'PATCH', { description: val });
        session.description = val;
        const newEl = document.createElement('div');
        newEl.className = val ? 'session-description' : 'session-description session-description-empty';
        newEl.textContent = val || 'Add notes…';
        input.replaceWith(newEl);
        newEl.addEventListener('click', (e) => { e.stopPropagation(); newEl.dispatchEvent(new MouseEvent('click', { bubbles: false })); });
      };
      input.addEventListener('blur', save);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); input.blur(); } if (e.key === 'Escape') { input.value = current; input.blur(); } });
    });

    const archiveBtn = row.querySelector('.btn-archive-session');
    if (archiveBtn) {
      archiveBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const willArchive = archiveBtn.dataset.archived !== 'true';
        try {
          await api(`/api/sessions/${activeProject.id}/${session.id}/archive`, 'PATCH', { archived: willArchive });
          session.archived = willArchive;
          renderSessions();
        } catch { /* error shown by api() */ }
      });
    }

    list.appendChild(row);
  }

  // "Show archived" toggle at bottom of list
  if (archived.length > 0) {
    const toggle = document.createElement('button');
    toggle.className = 'btn-show-archived btn-ghost btn-sm';
    toggle.textContent = showArchived
      ? `Hide archived`
      : `Show archived (${archived.length})`;
    toggle.addEventListener('click', () => { showArchived = !showArchived; renderSessions(); });
    list.appendChild(toggle);
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
  document.getElementById('sc-id').value           = scenario?.id          || '';
  document.getElementById('sc-id').disabled        = !!scenario; // can't change ID on edit
  document.getElementById('sc-name').value         = scenario?.name        || '';
  document.getElementById('sc-icon').value         = scenario?.icon        || '';
  document.getElementById('sc-description').value  = scenario?.description || '';
  document.getElementById('sc-shared-rules').value = scenario?.sessionTemplate?.rules || '';

  // Render participant rows
  renderParticipantRows(scenario?.participants || [
    { id: 'HUMAN', label: 'Human', mode: 'human' }
  ]);

  // Render automation rule rows
  renderRuleRows(scenario?.automationRules || []);

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
  row.className = 'sc-participant-card';
  const isHuman = p.mode === 'human';
  row.innerHTML = `
    <div class="sc-participant-row">
      <input class="sc-p-id"    type="text" placeholder="ID (e.g. CLAUDE-DEV)" value="${escHtml(p.id || '')}">
      <input class="sc-p-label" type="text" placeholder="Display name"         value="${escHtml(p.label || '')}">
      <select class="sc-p-mode">
        <option value="human"       ${p.mode === 'human'       ? 'selected' : ''}>human</option>
        <option value="interactive" ${p.mode === 'interactive' ? 'selected' : ''}>interactive</option>
        <option value="watcher"     ${!p.mode || (p.mode !== 'human' && p.mode !== 'interactive') ? 'selected' : ''}>watcher</option>
      </select>
      <button class="btn-sc-toggle-prompt btn-ghost btn-sm sc-prompt-toggle" title="System prompt">▸ Prompt</button>
      <button class="btn-sc-remove-p btn-ghost btn-icon" title="Remove">✕</button>
    </div>
    <div class="sc-p-prompt-row" style="display:${isHuman ? 'none' : 'none'}">
      <textarea class="sc-p-systemprompt" rows="3" placeholder="System prompt for this agent — its identity, role, and instructions.">${escHtml(p.systemPrompt || '')}</textarea>
    </div>
  `;
  const toggleBtn   = row.querySelector('.btn-sc-toggle-prompt');
  const promptRow   = row.querySelector('.sc-p-prompt-row');
  const modeSelect  = row.querySelector('.sc-p-mode');

  toggleBtn.addEventListener('click', () => {
    const open = promptRow.style.display === 'block';
    promptRow.style.display = open ? 'none' : 'block';
    toggleBtn.textContent   = open ? '▸ Prompt' : '▾ Prompt';
  });

  // Hide prompt toggle for human participants
  modeSelect.addEventListener('change', () => {
    const hide = modeSelect.value === 'human';
    toggleBtn.style.display = hide ? 'none' : '';
    if (hide) promptRow.style.display = 'none';
  });
  toggleBtn.style.display = modeSelect.value === 'human' ? 'none' : '';

  // Auto-expand if participant already has a system prompt
  if (p.systemPrompt) {
    promptRow.style.display = 'block';
    toggleBtn.textContent   = '▾ Prompt';
  }

  row.querySelector('.btn-sc-remove-p').addEventListener('click', () => row.remove());
  container.appendChild(row);
}

document.getElementById('btn-sc-add-participant').addEventListener('click', () => appendParticipantRow());

// ---------------------------------------------------------------------------
// Automation rules editor
// ---------------------------------------------------------------------------
function renderRuleRows(rules) {
  const container = document.getElementById('sc-rules-list');
  container.innerHTML = '';
  for (const rule of rules) appendRuleRow(rule);
}

function appendRuleRow(rule = {}) {
  const container = document.getElementById('sc-rules-list');
  const row = document.createElement('div');
  row.className = 'sc-rule-row';
  row.innerHTML = `
    <span class="sc-rule-label">When</span>
    <input class="sc-r-trigger" type="text" placeholder="author ID" value="${escHtml(rule.trigger?.author || '')}">
    <span class="sc-rule-label">posts → notify</span>
    <input class="sc-r-agent"   type="text" placeholder="agent ID"  value="${escHtml(rule.action?.agentId || '')}">
    <button class="btn-sc-remove-rule btn-ghost btn-icon" title="Remove rule">✕</button>
  `;
  row.querySelector('.btn-sc-remove-rule').addEventListener('click', () => row.remove());
  container.appendChild(row);
}

document.getElementById('btn-sc-add-rule').addEventListener('click', () => appendRuleRow());

document.getElementById('btn-sc-save').addEventListener('click', async () => {
  const id   = document.getElementById('sc-id').value.trim();
  const name = document.getElementById('sc-name').value.trim();
  if (!id || !name) {
    showError('Scenario ID and name are required.');
    return;
  }

  const pCards = document.querySelectorAll('#sc-participants .sc-participant-card');
  const participants = Array.from(pCards).map(card => {
    const pid    = card.querySelector('.sc-p-id').value.trim();
    const label  = card.querySelector('.sc-p-label').value.trim();
    const mode   = card.querySelector('.sc-p-mode').value;
    const prompt = card.querySelector('.sc-p-systemprompt').value.trim();
    return pid ? { id: pid, label, mode, ...(prompt ? { systemPrompt: prompt } : {}) } : null;
  }).filter(Boolean);

  const rRows = document.querySelectorAll('#sc-rules-list .sc-rule-row');
  const automationRules = Array.from(rRows).map((row, i) => {
    const triggerAuthor = row.querySelector('.sc-r-trigger').value.trim();
    const agentId       = row.querySelector('.sc-r-agent').value.trim();
    if (!triggerAuthor || !agentId) return null;
    return {
      id:      `rule-${i + 1}`,
      enabled: true,
      label:   `${triggerAuthor} posts → notify ${agentId}`,
      trigger: { type: 'entry_from', author: triggerAuthor },
      action:  { type: 'trigger_agent', agentId }
    };
  }).filter(Boolean);

  const rulesText = document.getElementById('sc-shared-rules').value.trim();
  const scenario = {
    id,
    name,
    icon:          document.getElementById('sc-icon').value.trim() || undefined,
    description:   document.getElementById('sc-description').value.trim() || undefined,
    participants,
    automationRules,
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
    updateCleanupButton();
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
    updateCleanupButton();
  } finally {
    setLoading(false);
  }
}

init();

// ---------------------------------------------------------------------------
// Workspace rename
// ---------------------------------------------------------------------------
document.getElementById('btn-rename-workspace').addEventListener('click', () => {
  const current = document.getElementById('workspace-name').textContent.trim();
  startRename({
    currentName: current,
    onSave: async (newName) => {
      await api('/api/workspace', 'PATCH', { name: newName });
      document.getElementById('workspace-name').textContent = newName;
    }
  });
});

// ---------------------------------------------------------------------------
// Cross-session search (within the open sessions panel)
// ---------------------------------------------------------------------------
let _searchDebounce = null;
document.getElementById('sessions-search').addEventListener('input', (e) => {
  const q = e.target.value.trim();
  clearTimeout(_searchDebounce);
  if (!q) {
    document.getElementById('sessions-search-results').style.display = 'none';
    document.getElementById('sessions-list').style.display = '';
    return;
  }
  _searchDebounce = setTimeout(async () => {
    if (!activeProject) return;
    const results = await api(`/api/projects/${activeProject.id}/search?q=${encodeURIComponent(q)}`);
    const container = document.getElementById('sessions-search-results');
    container.style.display = '';
    document.getElementById('sessions-list').style.display = 'none';
    if (!results || results.length === 0) {
      container.innerHTML = '<p class="search-empty">No matches found.</p>';
      return;
    }
    container.innerHTML = results.map(r => `
      <div class="search-result-card">
        <div class="search-result-meta">
          <span class="search-result-session">${escHtml(r.sessionName)}</span>
          <span class="search-result-author">${escHtml(r.author)}</span>
          <span class="search-result-time">${formatRelative(r.timestamp)}</span>
        </div>
        <div class="search-result-snippet">${escHtml(r.snippet)}</div>
      </div>
    `).join('');
  }, 300);
});

// ---------------------------------------------------------------------------
// Dark / light mode toggle
// ---------------------------------------------------------------------------
(function initTheme() {
  const saved = localStorage.getItem('agentorum_theme');
  if (saved) document.documentElement.dataset.theme = saved;
  const btn = document.getElementById('btn-theme-home');
  function updateThemeBtn() {
    const dark = document.documentElement.dataset.theme === 'dark' ||
      (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
    btn.textContent = dark ? '☀️' : '🌙';
    btn.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
  }
  updateThemeBtn();
  btn.addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme === 'dark' ||
      (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
    const next = dark ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('agentorum_theme', next);
    updateThemeBtn();
  });
})();

// When the browser restores this page from the back/forward cache (bfcache),
// the loading overlay may still be visible from the last navigation.  Reset it.
window.addEventListener('pageshow', (e) => {
  if (e.persisted) setLoading(false);
});
