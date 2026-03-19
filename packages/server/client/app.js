// Agentorum — app.js
// Vanilla JS browser client. No build step.

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const COLOR_PALETTE = ['#2563eb','#16a34a','#9333ea','#ea580c','#0891b2','#db2777'];

let allEntries      = [];   // full entry list received from server
let shownCount      = 20;   // how many we render (oldest hidden for perf)
let newSinceLoad    = new Set(); // ids of entries arriving after init
let collapseState   = {};   // id → true (collapsed)
let participantMap  = {};   // id → participant config object
let agentStatusMap  = {};   // id → { status, pid, lastResponseAt, logs }
let serverConfig    = {};   // full config from server
let activeLogAgent  = null; // which agent's log drawer is open
let searchQuery     = '';
let filterAuthors   = new Set(); // ids that are HIDDEN (unchecked)
let filterFrom      = '';
let filterTo        = '';
let filterNewOnly   = false;
let ws;

// ---------------------------------------------------------------------------
// WebSocket connection
// ---------------------------------------------------------------------------
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);

  ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    switch (msg.type) {
      case 'init':
        serverConfig   = msg.config || {};
        buildParticipantMap(serverConfig.participants || []);
        allEntries     = msg.entries;
        shownCount     = Math.min(20, allEntries.length);
        renderAll();
        renderParticipantPills();
        renderAgentCards();
        renderComposeAuthorOptions();
        renderRules();
        updateLoadOlderBtn();
        break;
      case 'entries_added':
        msg.entries.forEach(e => {
          allEntries.push(e);
          newSinceLoad.add(e.id);
          if (filterNewOnly || isVisible(e)) appendEntryCard(e);
        });
        updateNewBadge();
        break;
      case 'agent_status':
        agentStatusMap[msg.agent.id] = msg.agent;
        updateAgentCard(msg.agent.id);
        updateParticipantPill(msg.agent.id);
        break;
      case 'agent_log':
        if (activeLogAgent === msg.agentId) {
          const pre = document.getElementById('log-content');
          pre.textContent += msg.line + '\n';
          pre.scrollTop = pre.scrollHeight;
        }
        break;
      case 'config_updated':
        serverConfig = msg.config;
        buildParticipantMap(serverConfig.participants || []);
        renderParticipantPills();
        renderAgentCards();
        renderComposeAuthorOptions();
        break;
      case 'ping':
        break;
    }
  };

  ws.onclose = () => setTimeout(connect, 2000);
}

// ---------------------------------------------------------------------------
// Participant helpers
// ---------------------------------------------------------------------------
function buildParticipantMap(participants) {
  participantMap = {};
  participants.forEach((p, i) => {
    participantMap[p.id] = { color: COLOR_PALETTE[i % COLOR_PALETTE.length], ...p };
  });
}

function participantColor(id) {
  return participantMap[id]?.color || COLOR_PALETTE[0];
}

function participantName(id) {
  const p = participantMap[id];
  return p?.label || p?.name || id;
}

function participantRole(id) {
  return participantMap[id]?.role || '';
}

// ---------------------------------------------------------------------------
// Filter logic
// ---------------------------------------------------------------------------
function isVisible(entry) {
  if (filterAuthors.has(entry.author))          return false;
  if (filterNewOnly && !newSinceLoad.has(entry.id)) return false;
  if (filterFrom && entry.timestamp < filterFrom) return false;
  if (filterTo   && entry.timestamp > filterTo + ' 23:59:59') return false;
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    if (!entry.body.toLowerCase().includes(q) && !entry.author.toLowerCase().includes(q)) return false;
  }
  return true;
}

function highlight(text, query) {
  if (!query) return text;
  const re = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')})`, 'gi');
  return text.replace(re, '<mark>$1</mark>');
}

// ---------------------------------------------------------------------------
// Entry rendering
// ---------------------------------------------------------------------------
function ageClass(timestamp) {
  const diff = (Date.now() - new Date(timestamp.replace(' ', 'T') + 'Z')) / 1000;
  if (diff < 45)   return 'age-fresh';
  if (diff < 300)  return 'age-new';
  if (diff < 3600) return 'age-recent';
  return '';
}

function timeAgo(timestamp) {
  const diff = Math.floor((Date.now() - new Date(timestamp.replace(' ', 'T') + 'Z')) / 1000);
  if (diff < 60)   return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff/60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff/3600)}h ago`;
  return `${Math.floor(diff/86400)}d ago`;
}

function makeCard(entry) {
  const collapsed = collapseState[entry.id] !== false; // default: collapsed
  const color     = participantColor(entry.author);
  const name      = participantName(entry.author);
  const role      = participantRole(entry.author);
  const age       = ageClass(entry.timestamp);

  const card = document.createElement('div');
  card.className = `entry-card ${age} ${collapsed ? 'collapsed' : 'expanded'}`;
  card.dataset.id     = entry.id;
  card.dataset.author = entry.author;
  card.dataset.ts     = entry.timestamp;
  card.style.setProperty('--author-color', color);

  // Metadata badges (replyTo, stance, etc.)
  const metaBadges = Object.entries(entry.meta || {}).map(([k, v]) =>
    `<span class="meta-badge meta-${k}" title="${k}">${k}: ${v}</span>`
  ).join('');

  const bodyHtml = typeof marked !== 'undefined'
    ? marked.parse(searchQuery ? highlight(entry.body, searchQuery) : entry.body)
    : `<pre>${entry.body}</pre>`;

  card.innerHTML = `
    <div class="entry-header" data-id="${entry.id}">
      <span class="entry-author" style="color:${color}">${entry.author}</span>
      <span class="entry-name">${name}</span>
      ${role ? `<span class="entry-role">${role}</span>` : ''}
      ${metaBadges}
      <span class="entry-ts" title="${entry.timestamp}">${timeAgo(entry.timestamp)}</span>
      <span class="collapse-toggle">${collapsed ? '▸' : '▾'}</span>
    </div>
    <div class="entry-body">${bodyHtml}</div>
  `;

  card.querySelector('.entry-header').addEventListener('click', () => toggleCard(entry.id));
  return card;
}

function toggleCard(id) {
  const card = document.querySelector(`.entry-card[data-id="${id}"]`);
  if (!card) return;
  const nowCollapsed = card.classList.contains('expanded');
  card.classList.toggle('expanded',  !nowCollapsed);
  card.classList.toggle('collapsed',  nowCollapsed);
  card.querySelector('.collapse-toggle').textContent = nowCollapsed ? '▸' : '▾';
  collapseState[id] = nowCollapsed;
}

function renderAll() {
  const el    = document.getElementById('entries');
  el.innerHTML = '';
  const visible = allEntries.slice(allEntries.length - shownCount).filter(isVisible);
  visible.forEach(e => el.appendChild(makeCard(e)));
  renderFilterAuthors();
  refreshAgeClasses();
}

function appendEntryCard(entry) {
  const el   = document.getElementById('entries');
  const card = makeCard(entry);
  el.appendChild(card);
  maybeScrollToBottom();
}

// ---------------------------------------------------------------------------
// Scroll & new-entry badge
// ---------------------------------------------------------------------------
let userScrolledUp = false;

function maybeScrollToBottom() {
  if (!userScrolledUp) window.scrollTo(0, document.body.scrollHeight);
}

function updateNewBadge() {
  const badge = document.getElementById('new-badge');
  const count = [...newSinceLoad].filter(id => !collapseState[id]).length;
  if (userScrolledUp && count > 0) {
    badge.textContent = `↓ ${count} new`;
    badge.style.display = 'block';
  } else {
    badge.style.display = 'none';
  }
}

window.addEventListener('scroll', () => {
  userScrolledUp = window.scrollY < document.body.scrollHeight - window.innerHeight - 180;
  updateNewBadge();
});

document.getElementById('new-badge').addEventListener('click', () => {
  window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  userScrolledUp = false;
  updateNewBadge();
});

// Refresh age classes every 20s
setInterval(() => refreshAgeClasses(), 20_000);

function refreshAgeClasses() {
  document.querySelectorAll('.entry-card').forEach(card => {
    const ts = card.dataset.ts;
    card.classList.remove('age-fresh','age-new','age-recent');
    const cls = ageClass(ts);
    if (cls) card.classList.add(cls);
    const tsEl = card.querySelector('.entry-ts');
    if (tsEl) tsEl.textContent = timeAgo(ts);
  });
}

// ---------------------------------------------------------------------------
// Load older
// ---------------------------------------------------------------------------
function updateLoadOlderBtn() {
  const wrap = document.getElementById('load-older-wrap');
  wrap.style.display = shownCount < allEntries.length ? 'block' : 'none';
}

document.getElementById('btn-load-older').addEventListener('click', () => {
  const prev  = shownCount;
  shownCount  = Math.min(shownCount + 100, allEntries.length);
  const el    = document.getElementById('entries');
  const slice = allEntries.slice(allEntries.length - shownCount, allEntries.length - prev).filter(isVisible);
  const first = el.firstChild;
  slice.reverse().forEach(e => el.insertBefore(makeCard(e), first));
  updateLoadOlderBtn();
});

// ---------------------------------------------------------------------------
// Filter sidebar
// ---------------------------------------------------------------------------
function renderFilterAuthors() {
  // Show all configured participants first, then any chatlog authors not in config
  const configIds  = (serverConfig.participants || []).map(p => p.id);
  const entryIds   = [...new Set(allEntries.map(e => e.author))];
  const known      = [...new Set([...configIds, ...entryIds])];
  const el         = document.getElementById('filter-authors');
  el.innerHTML     = '';
  known.forEach(id => {
    const label = document.createElement('label');
    const cb    = document.createElement('input');
    cb.type    = 'checkbox';
    cb.checked = !filterAuthors.has(id);
    cb.addEventListener('change', () => {
      if (cb.checked) filterAuthors.delete(id); else filterAuthors.add(id);
      renderAll();
    });
    const dot = document.createElement('span');
    dot.className = 'author-dot';
    dot.style.background = participantColor(id);
    const displayName = participantName(id);
    label.appendChild(cb);
    label.appendChild(dot);
    label.appendChild(document.createTextNode(` ${displayName}`));
    el.appendChild(label);
  });
}

document.getElementById('filter-from').addEventListener('change', e => { filterFrom = e.target.value; renderAll(); });
document.getElementById('filter-to').addEventListener('change',   e => { filterTo   = e.target.value; renderAll(); });
document.getElementById('filter-new-only').addEventListener('change', e => { filterNewOnly = e.target.checked; renderAll(); });

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------
let searchTimer;
document.getElementById('search-input').addEventListener('input', e => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { searchQuery = e.target.value.trim(); renderAll(); }, 200);
});

// ---------------------------------------------------------------------------
// Collapse controls
// ---------------------------------------------------------------------------
document.getElementById('btn-expand-all').addEventListener('click', () => {
  allEntries.forEach(e => { collapseState[e.id] = false; });
  renderAll();
});
document.getElementById('btn-collapse-all').addEventListener('click', () => {
  allEntries.forEach(e => { collapseState[e.id] = true; });
  renderAll();
});
document.getElementById('btn-collapse-old').addEventListener('click', () => {
  const cutoff = prompt('Collapse entries before (YYYY-MM-DD):');
  if (!cutoff) return;
  allEntries.forEach(e => {
    if (e.timestamp < cutoff) collapseState[e.id] = true;
  });
  renderAll();
});

// ---------------------------------------------------------------------------
// Participant pills (topbar)
// ---------------------------------------------------------------------------
function renderParticipantPills() {
  const el = document.getElementById('participant-pills');
  el.innerHTML = '';
  (serverConfig.participants || []).forEach(p => {
    const pill       = document.createElement('span');
    pill.className   = 'participant-pill';
    pill.dataset.id  = p.id;
    pill.style.borderColor = participantColor(p.id);
    pill.textContent = p.id;
    el.appendChild(pill);
  });
}

function updateParticipantPill(id) {
  const pill   = document.querySelector(`.participant-pill[data-id="${id}"]`);
  if (!pill) return;
  const status = agentStatusMap[id]?.status || 'stopped';
  pill.classList.toggle('running', status === 'running');
}

// ---------------------------------------------------------------------------
// Agent cards (right panel)
// ---------------------------------------------------------------------------
function renderAgentCards() {
  const el = document.getElementById('agent-cards');
  el.innerHTML = '';
  (serverConfig.participants || []).filter(p => p.type === 'agent' || (p.agent && p.agent !== 'human')).forEach(p => {
    el.appendChild(makeAgentCard(p));
  });
}

function makeAgentCard(p) {
  const s    = agentStatusMap[p.id] || { status: 'stopped' };
  const card = document.createElement('div');
  card.className    = 'agent-card';
  card.dataset.id   = p.id;
  card.innerHTML = `
    <div class="agent-card-header">
      <span class="agent-id" style="color:${participantColor(p.id)}">${p.id}</span>
      <span class="agent-status ${s.status}">${s.status}</span>
    </div>
    <div class="agent-role">${p.role}</div>
    <div class="agent-actions">
      <button class="btn-start"   data-id="${p.id}">▶ Start</button>
      <button class="btn-stop"    data-id="${p.id}">■ Stop</button>
      <button class="btn-trigger" data-id="${p.id}">⚡ Trigger</button>
      <button class="btn-log"     data-id="${p.id}">📋 Logs</button>
    </div>
    ${s.lastResponseAt ? `<div class="agent-last">Last: ${timeAgo(s.lastResponseAt.replace('T',' ').slice(0,19))}</div>` : ''}
  `;
  return card;
}

function updateAgentCard(id) {
  const card = document.querySelector(`.agent-card[data-id="${id}"]`);
  if (!card) return;
  const p = serverConfig.participants.find(p => p.id === id);
  if (p) card.replaceWith(makeAgentCard(p));
}

// Agent card button delegation
document.getElementById('agent-cards').addEventListener('click', async e => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const id = btn.dataset.id;
  if (!id) return;
  if (btn.classList.contains('btn-start'))   await api(`/api/participants/${id}/start`, 'POST');
  if (btn.classList.contains('btn-stop'))    await api(`/api/participants/${id}/stop`,  'POST');
  if (btn.classList.contains('btn-trigger')) await api(`/api/participants/${id}/trigger`, 'POST');
  if (btn.classList.contains('btn-log'))     openLogDrawer(id);
});

// ---------------------------------------------------------------------------
// Log drawer
// ---------------------------------------------------------------------------
async function openLogDrawer(id) {
  activeLogAgent = id;
  const logs = await api(`/api/participants/${id}/logs`);
  document.getElementById('log-drawer-title').textContent = `Logs — ${id}`;
  document.getElementById('log-content').textContent = (logs || []).join('\n');
  document.getElementById('log-drawer').style.display = 'flex';
  const pre = document.getElementById('log-content');
  pre.scrollTop = pre.scrollHeight;
}

document.getElementById('btn-close-log').addEventListener('click', () => {
  document.getElementById('log-drawer').style.display = 'none';
  activeLogAgent = null;
});

// ---------------------------------------------------------------------------
// Compose area
// ---------------------------------------------------------------------------
document.getElementById('btn-compose-toggle').addEventListener('click', () => {
  const bar = document.getElementById('compose-bar');
  bar.style.display = bar.style.display === 'none' ? 'flex' : 'none';
});

function renderComposeAuthorOptions() {
  const sel = document.getElementById('compose-author');
  sel.innerHTML = '';
  (serverConfig.participants || []).forEach(p => {
    const opt   = document.createElement('option');
    opt.value   = p.id;
    opt.textContent = `${p.id} — ${p.name}`;
    sel.appendChild(opt);
  });
}

document.getElementById('btn-preview-toggle').addEventListener('click', () => {
  const preview = document.getElementById('compose-preview');
  const body    = document.getElementById('compose-body').value;
  if (preview.style.display === 'none') {
    preview.innerHTML = typeof marked !== 'undefined' ? marked.parse(body) : body;
    preview.style.display = 'block';
  } else {
    preview.style.display = 'none';
  }
});

document.getElementById('btn-post').addEventListener('click', async () => {
  const author = document.getElementById('compose-author').value;
  const body   = document.getElementById('compose-body').value.trim();
  if (!body) return;
  await api('/api/entries', 'POST', { author, body });
  document.getElementById('compose-body').value = '';
  document.getElementById('compose-preview').style.display = 'none';
  document.getElementById('compose-bar').style.display = 'none';
});

// ---------------------------------------------------------------------------
// Automation rules
// ---------------------------------------------------------------------------
function renderRules() {
  const el    = document.getElementById('rules-list');
  el.innerHTML = '';
  (serverConfig.automationRules || []).forEach(rule => {
    const row    = document.createElement('div');
    row.className = 'rule-row';
    row.innerHTML = `
      <label>
        <input type="checkbox" class="rule-toggle" data-id="${rule.id}" ${rule.enabled ? 'checked' : ''}>
        ${rule.label || `${rule.trigger?.author} → ${rule.action?.agentId}`}
      </label>
      <button class="rule-delete" data-id="${rule.id}">✕</button>
    `;
    el.appendChild(row);
  });
}

document.getElementById('rules-list').addEventListener('change', async e => {
  if (!e.target.classList.contains('rule-toggle')) return;
  await api(`/api/rules/${e.target.dataset.id}`, 'PUT', { enabled: e.target.checked });
});

document.getElementById('rules-list').addEventListener('click', async e => {
  if (!e.target.classList.contains('rule-delete')) return;
  if (!confirm('Delete this rule?')) return;
  await api(`/api/rules/${e.target.dataset.id}`, 'DELETE');
  serverConfig.automationRules = serverConfig.automationRules.filter(r => r.id !== e.target.dataset.id);
  renderRules();
});

document.getElementById('btn-add-rule').addEventListener('click', async () => {
  const triggerAuthor = prompt('Trigger when entry from participant ID:');
  if (!triggerAuthor) return;
  const agentId  = prompt('Then trigger participant ID:');
  if (!agentId) return;
  const delayMs  = parseInt(prompt('Delay in ms (e.g. 2000):', '2000') || '2000', 10);
  const rule = {
    enabled: true,
    label: `${triggerAuthor} → ${agentId} (${delayMs}ms)`,
    trigger: { type: 'entry_from', author: triggerAuthor },
    action:  { type: 'trigger_agent', agentId, delayMs }
  };
  const saved = await api('/api/rules', 'POST', rule);
  serverConfig.automationRules = [...(serverConfig.automationRules || []), saved];
  renderRules();
});

// ---------------------------------------------------------------------------
// Config modal
// ---------------------------------------------------------------------------
document.getElementById('btn-settings').addEventListener('click', () => {
  document.getElementById('cfg-chatlog').value = serverConfig.chatlog || '';
  document.getElementById('cfg-port').value    = serverConfig.port || 3737;
  document.getElementById('config-modal').style.display = 'flex';
});

document.getElementById('btn-cfg-cancel').addEventListener('click', () => {
  document.getElementById('config-modal').style.display = 'none';
});

document.getElementById('btn-cfg-save').addEventListener('click', async () => {
  const chatlog = document.getElementById('cfg-chatlog').value.trim();
  const port    = parseInt(document.getElementById('cfg-port').value, 10);
  await api('/api/config', 'PUT', { chatlog, port });
  document.getElementById('config-modal').style.display = 'none';
});

// ---------------------------------------------------------------------------
// API helper
// ---------------------------------------------------------------------------
async function api(path, method = 'GET', body = null) {
  const opts = { method, headers: {} };
  if (body) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  const res = await fetch(path, opts);
  return res.ok ? res.json().catch(() => null) : null;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
connect();
