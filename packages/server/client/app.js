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
let scoreMap        = {};   // participantId → { total, events[] }
let ratedEntryMap   = {};   // entryId → [{ participantId, event, score, rater }]
let nudgeMap        = {};   // participantId → { triggeredBy } — pending response nudge
let serverConfig    = {};   // full config from server
let activeLogAgent  = null; // which agent's log drawer is open
let pendingRateEntry = null; // entry currently being rated by human
let _sessionToken   = null; // session token, used to persist init-done state
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
        applyScores(msg.scores || {});
        renderAll();
        renderParticipantPills();
        renderAgentCards();
        renderInitAgentsPanel(true);   // autoShow=true — modal fires on session load
        renderComposeAuthorOptions();
        renderRules();
        if (msg.projectId && msg.sessionId) populateSessionSwitcher(msg.projectId, msg.sessionId);
        updateLoadOlderBtn();
        break;
      case 'entries_added':
        msg.entries.forEach(e => {
          allEntries.push(e);
          newSinceLoad.add(e.id);
          // If this participant had a pending nudge, clear it — they responded
          if (nudgeMap[e.author]) {
            delete nudgeMap[e.author];
            updateAgentCard(e.author);
          }
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
      case 'scores_updated':
        applyScores(msg.scores || {});
        renderAgentCards();   // refresh score badges
        renderAll();          // refresh entry pips
        break;
      case 'agent_nudge':
        // An automation rule fired for an interactive agent — the server can't
        // auto-trigger it, so it notifies the UI to prompt the user instead.
        nudgeMap[msg.agentId] = { triggeredBy: msg.triggeredBy };
        updateAgentCard(msg.agentId);
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
// Scoring helpers
// ---------------------------------------------------------------------------
function applyScores(scores) {
  scoreMap = scores;
  ratedEntryMap = {};
  for (const [participantId, data] of Object.entries(scores)) {
    for (const ev of (data.events || [])) {
      if (!ev.entryRef) continue;
      if (!ratedEntryMap[ev.entryRef]) ratedEntryMap[ev.entryRef] = [];
      ratedEntryMap[ev.entryRef].push({ participantId, event: ev.event, score: ev.score, rater: ev.rater });
    }
  }
}

function scoreLabel(total) {
  if (total === 0) return '±0';
  return total > 0 ? `+${total}` : `${total}`;
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
  // Collapse logic:
  //   - If the user has explicitly toggled this card, respect that choice.
  //   - Otherwise: entries that arrived this session (newSinceLoad) open by default;
  //     historical entries loaded on init stay collapsed.
  const collapsed = collapseState[entry.id] ?? !newSinceLoad.has(entry.id);
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

  // Rating pips — show any ratings this entry has received
  const ratings    = ratedEntryMap[entry.id] || [];
  const ratingPips = ratings.map(r => {
    const cls = r.score > 0 ? 'pip-pos' : 'pip-neg';
    return `<span class="rating-pip ${cls}" title="${r.event} (${r.score > 0 ? '+' : ''}${r.score}) by ${r.rater}">${r.score > 0 ? '+' : ''}${r.score} ${r.event}</span>`;
  }).join('');

  // Hide rate button for rating entries themselves (no meta-ratings)
  const isRatingEntry = entry.meta?.type === 'rating';

  card.innerHTML = `
    <div class="entry-header" data-id="${entry.id}">
      <span class="entry-author" style="color:${color}">${entry.author}</span>
      <span class="entry-name">${name}</span>
      ${role ? `<span class="entry-role">${role}</span>` : ''}
      ${metaBadges}
      ${ratingPips}
      <span class="entry-ts" title="${entry.timestamp}">${timeAgo(entry.timestamp)}</span>
      ${!isRatingEntry ? `<button class="btn-rate-entry" data-id="${entry.id}" title="Rate this entry">★</button>` : ''}
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

  // One-shot arrival animation: slide up + participant-coloured flash.
  // Applied as inline style so it wins over all CSS class-based animations
  // without needing !important.  On completion the inline style is cleared
  // and the normal age-class animations (age-fresh pulse etc.) take over.
  card.style.animation = 'entry-arrive 1.4s cubic-bezier(0.16, 1, 0.3, 1) forwards';
  card.addEventListener('animationend', () => { card.style.animation = ''; }, { once: true });

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
    const p = serverConfig.participants?.find(p => p.id === id);
    const isHuman = p?.agent === 'human' || p?.type === 'human';
    const displayLabel = p?.label || p?.name || id;
    const displayName  = displayLabel !== id ? `${displayLabel} (${id})` : id;
    label.appendChild(cb);
    label.appendChild(dot);
    label.appendChild(document.createTextNode(` ${displayName}`));
    if (isHuman) {
      const you = document.createElement('span');
      you.textContent = ' ← you';
      you.style.cssText = 'font-size:0.75em;opacity:0.55;font-style:italic;';
      label.appendChild(you);
    }
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

/**
 * Returns the control mode for a participant, used to decide which card
 * controls and init steps to show.
 *
 *  'interactive' — user-managed CLI session (Claude Code, Codex, etc.)
 *                  Requires the copy-paste init step so the agent reads its
 *                  rules file.  Only this mode triggers the Initialize Agents
 *                  modal and sidebar section.
 *
 *  'api'         — direct LLM API call managed by the server (future).
 *                  No manual init required; the server calls the provider
 *                  directly.  No watcher subprocess is spawned.
 *
 *  'watcher'     — default; server spawns and manages a CLI subprocess
 *                  (claude --print / codex --full-auto) via the watcher.
 *                  Shows Start / Stop / Trigger / Logs controls.
 */
function agentControlMode(p) {
  if (p.mode === 'interactive') return 'interactive';
  if (p.mode === 'api')         return 'api';
  return 'watcher';
}

function renderAgentCards() {
  const el = document.getElementById('agent-cards');
  el.innerHTML = '';
  (serverConfig.participants || []).filter(p => p.type === 'agent' || (p.agent && p.agent !== 'human')).forEach(p => {
    el.appendChild(makeAgentCard(p));
  });
}

function makeAgentCard(p) {
  const s        = agentStatusMap[p.id] || { status: 'stopped' };
  const ctrlMode = agentControlMode(p);
  const card     = document.createElement('div');
  card.className = 'agent-card';
  card.dataset.id = p.id;
  const label    = p.label || p.name || p.id;

  // Score badge — shown for any mode once ratings exist
  const sc         = scoreMap[p.id];
  const scoreClass = sc ? (sc.total > 0 ? 'pos' : sc.total < 0 ? 'neg' : 'zero') : '';
  const scoreBadge = sc != null
    ? `<span class="agent-score-badge ${scoreClass}" title="${sc.events.length} rating event(s)">${scoreLabel(sc.total)}</span>`
    : '';

  // Mode badge — shown for non-default modes so users know how the agent connects
  let modeBadge = '';
  if (ctrlMode === 'interactive') {
    modeBadge = `<span class="agent-mode-badge interactive" title="Runs in your terminal — paste the init command from the Interactive Agents panel below">interactive</span>`;
  } else if (ctrlMode === 'api') {
    modeBadge = `<span class="agent-mode-badge api" title="Direct API call — no manual setup required">api</span>`;
  }
  // watcher: default mode — no badge needed

  // Status pill — only meaningful for watcher (server manages the subprocess)
  const statusPill = ctrlMode === 'watcher'
    ? `<span class="agent-status ${s.status}">${s.status}</span>`
    : '';

  // Nudge badge — shown when an automation rule fired for this interactive agent
  const nudge = nudgeMap[p.id];
  const nudgeBadge = nudge
    ? `<span class="agent-nudge-badge" title="Triggered by ${nudge.triggeredBy} — prompt this agent to respond">⚡ respond</span>`
    : '';

  // Action controls — differ by mode
  let actions;
  if (ctrlMode === 'interactive') {
    // User runs their own CLI session; the server does not spawn anything.
    // The copy-paste init command is in the Interactive Agents panel below.
    actions = `<span class="agent-interactive-hint">Runs in your terminal · see Interactive Agents ↓</span>`;
  } else if (ctrlMode === 'api') {
    // Server calls the LLM provider API directly — no manual setup required.
    actions = `<span class="agent-interactive-hint">Direct API call — no setup required</span>`;
  } else {
    // Watcher mode: server spawns and manages a CLI subprocess.
    actions = `<button class="btn-start"   data-id="${p.id}">▶ Start</button>
               <button class="btn-stop"    data-id="${p.id}">■ Stop</button>
               <button class="btn-trigger" data-id="${p.id}">⚡ Trigger</button>
               <button class="btn-log"     data-id="${p.id}">📋 Logs</button>`;
  }

  card.innerHTML = `
    <div class="agent-card-header">
      <span class="agent-id" style="color:${participantColor(p.id)}">${p.id}</span>
      <span class="agent-label-name">${label}</span>
      ${modeBadge}
      ${scoreBadge}
      ${statusPill}
      ${nudgeBadge}
    </div>
    <div class="agent-actions">${actions}</div>
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
// Interactive Agents — modal + sidebar panel
//
// This section is ONLY relevant to participants with mode === 'interactive'
// (i.e. CLI-based coding agents like Claude Code and Codex that the user
// runs in their own terminal window).
//
// Agents backed by direct LLM API calls (mode === 'api') or server-managed
// watcher subprocesses (default / mode === 'watcher') do NOT need this
// init step and are never shown here.
// ---------------------------------------------------------------------------
let _initAgentsData = null;  // cached from /api/session

function makeCopyBtn(cmd, cls) {
  const btn = document.createElement('button');
  btn.className = cls;
  btn.textContent = 'Copy';
  btn.addEventListener('click', () => {
    navigator.clipboard.writeText(cmd).then(() => {
      btn.textContent = '✓ Copied';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
    });
  });
  return btn;
}

function buildModalCard(p) {
  const color = participantColor(p.id);
  const card  = document.createElement('div');
  card.className = 'init-modal-card';
  card.innerHTML = `
    <div class="init-modal-card-header">
      <span class="init-modal-agent-id" style="color:${color}">${p.id}</span>
      <span class="init-modal-agent-label">${p.label}</span>
    </div>
    <div class="init-modal-step">Paste into ${p.label}'s session window:</div>
    <div class="init-modal-command-row">
      <code class="init-modal-command">${p.initCommand}</code>
    </div>
  `;
  const row = card.querySelector('.init-modal-command-row');
  row.appendChild(makeCopyBtn(p.initCommand, 'btn-copy-modal'));
  return card;
}

function openInitModal(participants) {
  const container = document.getElementById('init-modal-cards');
  container.innerHTML = '';
  participants.forEach(p => container.appendChild(buildModalCard(p)));
  document.getElementById('init-modal').style.display = 'flex';
}

function closeInitModal() {
  document.getElementById('init-modal').style.display = 'none';
}

function collapseInitAgentsPanel() {
  document.getElementById('init-agent-cards').style.display = 'none';
  document.getElementById('init-agents-chevron').textContent = '▸';
}

function expandInitAgentsPanel() {
  document.getElementById('init-agent-cards').style.display = 'block';
  document.getElementById('init-agents-chevron').textContent = '▾';
}

// "Done" — close modal, collapse sidebar, and remember so it won't re-fire on reload
document.getElementById('btn-init-done').addEventListener('click', () => {
  closeInitModal();
  collapseInitAgentsPanel();
  if (_sessionToken) {
    localStorage.setItem(`agentorum_init_done_${_sessionToken}`, '1');
  }
});

// "Show again later" — close modal but leave sidebar expanded so commands stay visible
document.getElementById('btn-init-show-again').addEventListener('click', closeInitModal);

// Clicking the backdrop closes the modal (no collapse — treat as accidental dismiss)
document.getElementById('init-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('init-modal')) closeInitModal();
});

// Heading click — toggle the sidebar body open/closed
document.getElementById('init-agents-heading').addEventListener('click', e => {
  if (e.target.closest('#btn-reinit')) return;  // reinit button handled separately
  const cards = document.getElementById('init-agent-cards');
  if (cards.style.display === 'none') expandInitAgentsPanel();
  else collapseInitAgentsPanel();
});

// Re-open button — expand sidebar first so the cards are visible, then open modal
document.getElementById('btn-reinit').addEventListener('click', e => {
  e.stopPropagation();  // don't bubble to heading toggle
  if (_initAgentsData?.length) {
    expandInitAgentsPanel();
    openInitModal(_initAgentsData);
  }
});

async function renderInitAgentsPanel(autoShow = false) {
  const section = document.getElementById('init-agents-section');
  if (!section) return;

  // Only participants with mode === 'interactive' need a manual init step.
  // If there are none, keep the section hidden and do not show the modal.
  const data = await api('/api/session');
  if (!data || !data.active || !data.interactiveParticipants?.length) {
    section.style.display = 'none';
    return;
  }

  _sessionToken   = data.token;
  _initAgentsData = data.interactiveParticipants;

  // Sidebar compact cards (copy buttons only, no modal chrome)
  section.style.display = 'block';
  const container = document.getElementById('init-agent-cards');
  container.innerHTML = '';
  data.interactiveParticipants.forEach(p => {
    const color = participantColor(p.id);
    const card  = document.createElement('div');
    card.className = 'init-agent-card';
    card.innerHTML = `
      <div class="init-agent-header">
        <span class="init-agent-id" style="color:${color}">${p.id}</span>
        <span class="init-agent-label">${p.label}</span>
      </div>
      <div class="init-command-row">
        <code class="init-command">${p.initCommand}</code>
      </div>
    `;
    const row = card.querySelector('.init-command-row');
    row.appendChild(makeCopyBtn(p.initCommand, 'btn-copy'));
    container.appendChild(card);
  });

  // Auto-show modal on session load — but only once per session.
  // After the user clicks "Done", we store a flag in localStorage keyed on
  // the session token so reloads and reconnects don't re-prompt.
  const alreadyDone = data.token && localStorage.getItem(`agentorum_init_done_${data.token}`);
  if (autoShow && !alreadyDone) openInitModal(data.interactiveParticipants);
}

// Sidebar copy buttons (delegated, catches any remaining plain .btn-copy clicks)
document.getElementById('init-agent-cards').addEventListener('click', e => {
  // Individual copy buttons are attached directly — this is a safety fallback
});

// ---------------------------------------------------------------------------
// Rating modal
// ---------------------------------------------------------------------------
const EVENT_META = {
  catch:    { label: 'Catch',    score: +2, desc: 'Correctly identified an error or flaw in another agent\'s argument' },
  insight:  { label: 'Insight',  score: +2, desc: 'Provided a novel, valuable perspective or insight' },
  confirm:  { label: 'Confirm',  score: +1, desc: 'Corroborated a claim with supporting evidence' },
  error:    { label: 'Error',    score: -2, desc: 'Made a factual error or logical mistake' },
  omission: { label: 'Omission', score: -1, desc: 'Failed to address a key relevant point' },
  retract:  { label: 'Retract',  score: -1, desc: 'Withdrew a previous claim without adequate justification' },
  deflect:  { label: 'Deflect',  score: -1, desc: 'Avoided a direct question or challenge' }
};

function openRateModal(entryId) {
  const entry = allEntries.find(e => e.id === entryId);
  if (!entry) return;
  pendingRateEntry = entry;

  // Populate entry reference card
  const refEl = document.getElementById('rate-modal-entry-ref');
  const color  = participantColor(entry.author);
  refEl.innerHTML = `
    <div class="rate-entry-author" style="color:${color}">${entry.author}
      <span style="font-weight:400;color:var(--text-muted);font-size:11px;margin-left:6px">${timeAgo(entry.timestamp)}</span>
    </div>
    <div class="rate-entry-preview">${entry.body.replace(/<[^>]*>/g, '').slice(0, 200)}</div>
  `;

  // Populate author dropdown — pre-select first human participant
  const authorSel = document.getElementById('rate-author');
  authorSel.innerHTML = '';
  (serverConfig.participants || []).forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `${p.id}${p.label && p.label !== p.id ? ` — ${p.label}` : ''}`;
    if (p.agent === 'human' || p.type === 'human') opt.selected = true;
    authorSel.appendChild(opt);
  });

  // Populate event type radio buttons
  const group = document.getElementById('rate-event-group');
  group.innerHTML = '<legend>Event type</legend>';
  Object.entries(EVENT_META).forEach(([key, meta], i) => {
    const scoreClass = meta.score > 0 ? 'pos' : 'neg';
    const scoreLabel = meta.score > 0 ? `+${meta.score}` : `${meta.score}`;
    const label = document.createElement('label');
    label.className = 'rate-event-option';
    label.innerHTML = `
      <input type="radio" name="rate-event" value="${key}" ${i === 0 ? 'checked' : ''}>
      <div class="rate-event-label">
        <div class="rate-event-name-row">
          <span class="rate-event-name">${meta.label}</span>
          <span class="rate-event-score ${scoreClass}">${scoreLabel}</span>
        </div>
        <span class="rate-event-desc">${meta.desc}</span>
      </div>
    `;
    group.appendChild(label);
  });

  // Clear previous note
  document.getElementById('rate-note').value = '';

  document.getElementById('rate-modal').style.display = 'flex';
}

function closeRateModal() {
  document.getElementById('rate-modal').style.display = 'none';
  pendingRateEntry = null;
}

document.getElementById('btn-rate-cancel').addEventListener('click', closeRateModal);

// Backdrop click closes
document.getElementById('rate-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('rate-modal')) closeRateModal();
});

document.getElementById('btn-rate-submit').addEventListener('click', async () => {
  if (!pendingRateEntry) return;

  const author    = document.getElementById('rate-author').value;
  const eventKey  = document.querySelector('input[name="rate-event"]:checked')?.value;
  const note      = document.getElementById('rate-note').value.trim();

  if (!eventKey) return;

  const meta = {
    type:     'rating',
    target:   pendingRateEntry.author,
    event:    eventKey,
    score:    String(EVENT_META[eventKey]?.score ?? 0),
    entryRef: pendingRateEntry.id
  };

  const body = note || `Rating: ${eventKey}`;

  const btn = document.getElementById('btn-rate-submit');
  btn.disabled = true;
  btn.textContent = 'Submitting…';

  await api('/api/entries', 'POST', { author, body, meta });

  btn.disabled = false;
  btn.textContent = 'Submit rating';
  closeRateModal();
});

// Event delegation — rate button inside entry headers
document.getElementById('entries').addEventListener('click', e => {
  const btn = e.target.closest('.btn-rate-entry');
  if (!btn) return;
  e.stopPropagation();   // prevent entry-header click (collapse toggle)
  openRateModal(btn.dataset.id);
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

// ---------------------------------------------------------------------------
// File attachment
// ---------------------------------------------------------------------------
document.getElementById('compose-file').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = '';  // reset so same file can be re-selected

  // Show uploading indicator
  const attachments = document.getElementById('compose-attachments');
  const indicator   = document.createElement('span');
  indicator.className  = 'attach-indicator uploading';
  indicator.textContent = `⏳ Uploading ${file.name}…`;
  attachments.appendChild(indicator);

  // Read as base64
  const base64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

  const result = await api('/api/media/upload', 'POST', { filename: file.name, data: base64 });
  indicator.remove();

  if (!result?.ok) {
    const err = document.createElement('span');
    err.className   = 'attach-indicator error';
    err.textContent = `❌ Upload failed: ${file.name}`;
    attachments.appendChild(err);
    setTimeout(() => err.remove(), 4000);
    return;
  }

  // Insert Markdown reference at cursor
  const textarea  = document.getElementById('compose-body');
  const isVideo   = file.type.startsWith('video/');
  const isPdf     = file.type === 'application/pdf';
  let   mdRef;
  if (isVideo)     mdRef = `\n@[video](${result.url})\n`;
  else if (isPdf)  mdRef = `\n[${result.filename}](${result.url})\n`;
  else             mdRef = `\n![${result.filename}](${result.url})\n`;

  const start = textarea.selectionStart;
  const end   = textarea.selectionEnd;
  textarea.value = textarea.value.slice(0, start) + mdRef + textarea.value.slice(end);
  textarea.selectionStart = textarea.selectionEnd = start + mdRef.length;
  textarea.focus();

  // Show thumbnail badge
  const badge = document.createElement('span');
  badge.className   = 'attach-indicator done';
  badge.textContent = `✓ ${result.filename}`;
  attachments.appendChild(badge);
  setTimeout(() => badge.remove(), 5000);
});

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
// Summary modal
// ---------------------------------------------------------------------------
document.getElementById('btn-summary').addEventListener('click', async () => {
  const data = await api('/api/summary');
  document.getElementById('summary-body').value = data?.content || '';
  document.getElementById('summary-modal').style.display = 'flex';
  document.getElementById('summary-body').focus();
});

function closeSummaryModal() {
  document.getElementById('summary-modal').style.display = 'none';
}

document.getElementById('btn-summary-close').addEventListener('click', closeSummaryModal);
document.getElementById('btn-summary-cancel').addEventListener('click', closeSummaryModal);
document.getElementById('summary-modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeSummaryModal();
});

document.getElementById('btn-summary-save').addEventListener('click', async () => {
  const content = document.getElementById('summary-body').value;
  await api('/api/summary', 'PUT', { content });
  closeSummaryModal();
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
// Custom marked renderer — @[video](url) → <video> element
// ---------------------------------------------------------------------------
function patchMarkedForVideo() {
  if (typeof marked === 'undefined') return;
  const renderer = new marked.Renderer();
  const _paragraph = renderer.paragraph.bind(renderer);
  renderer.paragraph = (token) => {
    const text = typeof token === 'string' ? token : token.text || '';
    // Match @[video](url) anywhere in the paragraph
    const videoRe = /@\[video\]\(([^)]+)\)/g;
    if (videoRe.test(text)) {
      return text.replace(/@\[video\]\(([^)]+)\)/g, (_, url) =>
        `<video controls style="max-width:100%;border-radius:4px;margin:.4em 0">` +
        `<source src="${url}"><p><a href="${url}">Download video</a></p></video>`
      );
    }
    return _paragraph(token);
  };
  marked.use({ renderer });
}

// ---------------------------------------------------------------------------
// Session switcher
// ---------------------------------------------------------------------------
async function populateSessionSwitcher(projectId, activeSessionId) {
  const sel = document.getElementById('session-switcher');
  if (!sel) return;
  try {
    const sessions = await api(`/api/projects/${projectId}/sessions`);
    if (!sessions || sessions.length < 2) return; // no need for switcher with only 1 session
    sel.innerHTML = '';
    sessions.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name || s.id;
      if (s.id === activeSessionId) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.style.display = '';
    sel.addEventListener('change', async () => {
      const sid = sel.value;
      if (sid === activeSessionId) return;
      await fetch(`/api/sessions/${projectId}/${sid}/open`, { method: 'POST' });
      window.location.reload();
    });
  } catch { /* non-fatal */ }
}

// Boot — patch marked once it is loaded (it loads via CDN after this module)
window.addEventListener('load', patchMarkedForVideo);
connect();

// When the browser restores this page from bfcache (Back button), the
// WebSocket connection is stale and the page state is frozen mid-session.
// Force a reload so the WS reconnects and the UI reflects current state.
window.addEventListener('pageshow', (e) => {
  if (e.persisted) window.location.reload();
});
