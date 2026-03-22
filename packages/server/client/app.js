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
let _initDoneKey    = null; // localStorage key for "init done" flag (projectId:sessionId)
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
        resolveEntryTimes(allEntries);
        shownCount     = Math.min(20, allEntries.length);
        applyScores(msg.scores || {});
        // Restore filter state from localStorage
        try {
          const saved = localStorage.getItem('agentorum_filter_hidden');
          if (saved) filterAuthors = new Set(JSON.parse(saved));
        } catch {}
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
          resolveEntryTimes(allEntries);
          newSinceLoad.add(e.id);
          // If this participant had a pending nudge, clear it — they responded
          if (nudgeMap[e.author]) {
            delete nudgeMap[e.author];
            updateAgentCard(e.author);
          }
          if (filterNewOnly || isVisible(e)) appendEntryCard(e);
          notifyNewEntry(e);
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
        // Auto-refresh trajectory chart if open
        if (document.getElementById('score-trajectory').style.display === 'flex') renderScoreTrajectory();
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
// ---------------------------------------------------------------------------
// Timestamp resolution
//
// The chatlog mixes UTC timestamps (server-generated via toISOString) and
// local timestamps (written by interactive agents).  We cannot distinguish
// them from the string alone.  Strategy:
//
//   1. Parse each timestamp as BOTH local and UTC.
//   2. Discard any interpretation that lands in the future.
//   3. Pick the interpretation closest to "now" (least stale).
//   4. Enforce monotonicity: each entry must be >= the previous one,
//      because chatlog append order IS chronological order.
//
// The result is cached in _resolvedTimes (entry.id → ms).
// ---------------------------------------------------------------------------
const _resolvedTimes = {};

function resolveEntryTimes(entries) {
  const now = Date.now();
  let prevMs = 0;
  for (const entry of entries) {
    if (_resolvedTimes[entry.id]) {
      prevMs = Math.max(prevMs, _resolvedTimes[entry.id]);
      continue;
    }
    const iso = entry.timestamp.replace(' ', 'T');
    const asLocal = new Date(iso).getTime();
    const asUtc   = new Date(iso + 'Z').getTime();

    // Collect valid (non-NaN) interpretations — include future ones too
    const all = [];
    if (!isNaN(asLocal)) all.push(asLocal);
    if (!isNaN(asUtc))   all.push(asUtc);
    if (all.length === 0) { _resolvedTimes[entry.id] = now; prevMs = now; continue; }

    // Prefer past interpretations; if none, use the closest future one
    const past = all.filter(t => t <= now);
    let best;
    if (past.length > 0) {
      // Pick the one closest to now (most plausible)
      best = past.reduce((a, b) => (now - a) < (now - b) ? a : b);
    } else {
      // All in future — pick closest to now (least far ahead)
      best = all.reduce((a, b) => (a - now) < (b - now) ? a : b);
    }
    // Enforce monotonicity — entry can't be older than the one before it
    best = Math.max(best, prevMs);
    _resolvedTimes[entry.id] = best;
    prevMs = best;
  }
}

function parseEntryTime(timestamp, entryId) {
  if (entryId && _resolvedTimes[entryId]) return _resolvedTimes[entryId];
  // Fallback for calls without an entryId (e.g. agent card "last response")
  const iso = timestamp.replace(' ', 'T');
  const asLocal = new Date(iso).getTime();
  const asUtc   = new Date(iso + 'Z').getTime();
  const now = Date.now();
  const all = [];
  if (!isNaN(asLocal)) all.push(asLocal);
  if (!isNaN(asUtc))   all.push(asUtc);
  if (all.length === 0) return now;
  const past = all.filter(t => t <= now);
  if (past.length > 0) return past.reduce((a, b) => (now - a) < (now - b) ? a : b);
  return all.reduce((a, b) => (a - now) < (b - now) ? a : b);
}

function ageClass(timestamp, entryId) {
  const diff = Math.max(0, (Date.now() - parseEntryTime(timestamp, entryId)) / 1000);
  if (diff < 45)   return 'age-fresh';
  if (diff < 300)  return 'age-new';
  if (diff < 3600) return 'age-recent';
  return '';
}

function formatLocalTime(timestamp, entryId) {
  const ms = parseEntryTime(timestamp, entryId);
  const d = new Date(ms);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatTimestamp(timestamp) {
  // Show the raw timestamp in a compact form: "Mar 21, 23:32" or "11:32 PM"
  // Parse the raw string directly (no UTC/local guessing — just show what's written)
  const parts = timestamp.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!parts) return timestamp;
  const [, yr, mo, dy, hh, mm] = parts;
  const months = ['', 'Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const today = new Date();
  const isToday = (parseInt(yr) === today.getFullYear() &&
                   parseInt(mo) === (today.getMonth()+1) &&
                   parseInt(dy) === today.getDate());
  if (isToday) return `${hh}:${mm}`;
  return `${months[parseInt(mo)]} ${parseInt(dy)}, ${hh}:${mm}`;
}

function timeAgo(timestamp, entryId) {
  const ms   = parseEntryTime(timestamp, entryId);
  const diff = Math.floor((Date.now() - ms) / 1000);
  if (diff < 0)     return 'just now';   // future timestamp — display gracefully
  if (diff < 60)    return `${diff}s ago`;
  if (diff < 3600)  return `${Math.floor(diff/60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff/3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff/86400)}d ago`;
  // Older than 7 days — show the date
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined });
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
  const age       = ageClass(entry.timestamp, entry.id);

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
      <a class="entry-ts" href="#entry-${entry.id}" title="${timeAgo(entry.timestamp, entry.id)}" onclick="event.stopPropagation();history.replaceState(null,'','#entry-${entry.id}')">${formatTimestamp(entry.timestamp)}</a>
      <button class="btn-copy-entry" data-body="${entry.body.replace(/"/g,'&quot;')}" title="Copy to clipboard">📋</button>
      ${!isRatingEntry ? `<button class="btn-rate-entry" data-id="${entry.id}" title="Rate this entry">★</button>` : ''}
      <button class="btn-delete-entry" data-id="${entry.id}" title="Delete this entry">🗑</button>
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

  // One-shot arrival animation: slide up + participant-colored flash.
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
    const id = card.dataset.id;
    card.classList.remove('age-fresh','age-new','age-recent');
    const cls = ageClass(ts, id);
    if (cls) card.classList.add(cls);
    const tsEl = card.querySelector('.entry-ts');
    if (tsEl) tsEl.title = timeAgo(ts, id);
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
      try { localStorage.setItem('agentorum_filter_hidden', JSON.stringify([...filterAuthors])); } catch {}
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

  const entryCount = allEntries.filter(e => e.author === p.id).length;
  const countBadge = entryCount > 0
    ? `<span class="agent-entry-count" title="${entryCount} entries posted">${entryCount}</span>`
    : '';

  card.innerHTML = `
    <div class="agent-card-header">
      <span class="agent-id" style="color:${participantColor(p.id)}">${p.id}</span>
      <span class="agent-label-name">${label}</span>
      ${modeBadge}
      ${scoreBadge}
      ${countBadge}
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

// Score badge click → score breakdown modal
document.getElementById('agent-cards').addEventListener('click', e => {
  const badge = e.target.closest('.agent-score-badge');
  if (!badge) return;
  const card  = badge.closest('.agent-card');
  const id    = card?.dataset.id;
  if (!id) return;
  openScoreModal(id);
});

let _scoreModalParticipant = null;

function openScoreModal(participantId) {
  _scoreModalParticipant = participantId;
  const sc  = scoreMap[participantId];
  const p   = (serverConfig.participants || []).find(p => p.id === participantId);
  const name = p?.label || p?.name || participantId;
  document.getElementById('score-modal-title').textContent = `${participantId} — ${name}`;
  document.getElementById('score-modal-total').innerHTML =
    sc ? `<span class="score-total ${sc.total > 0 ? 'pos' : sc.total < 0 ? 'neg' : 'zero'}">${scoreLabel(sc.total)} total</span> <span class="score-event-count">(${sc.events.length} events)</span>` : 'No ratings yet.';

  // Populate event type filter
  const filterEl = document.getElementById('score-filter-type');
  filterEl.innerHTML = '<option value="">All events</option>';
  if (sc?.events?.length) {
    const types = [...new Set(sc.events.map(ev => ev.event))].sort();
    types.forEach(t => { const o = document.createElement('option'); o.value = t; o.textContent = t; filterEl.appendChild(o); });
  }
  filterEl.value = '';

  renderScoreEvents(participantId, '');
  document.getElementById('score-modal').style.display = 'flex';
}

function renderScoreEvents(participantId, filterType) {
  const sc = scoreMap[participantId];
  const eventsEl = document.getElementById('score-modal-events');
  eventsEl.innerHTML = '';
  if (sc?.events?.length) {
    const filtered = filterType ? sc.events.filter(ev => ev.event === filterType) : sc.events;
    filtered.slice().reverse().forEach(ev => {
      const row = document.createElement('div');
      row.className = 'score-event-row';
      const pts = ev.score > 0 ? `+${ev.score}` : `${ev.score}`;
      row.innerHTML = `
        <span class="score-event-pts ${ev.score > 0 ? 'pos' : 'neg'}">${pts}</span>
        <span class="score-event-type">${ev.event}</span>
        <span class="score-event-rater">by ${ev.rater}</span>
        ${ev.note ? `<span class="score-event-note">${ev.note}</span>` : ''}
        <span class="score-event-ts">${timeAgo(ev.timestamp)}</span>
      `;
      eventsEl.appendChild(row);
    });
    if (filtered.length === 0) eventsEl.innerHTML = '<p class="score-empty">No events of this type.</p>';
  } else {
    eventsEl.innerHTML = '<p class="score-empty">No rating events yet.</p>';
  }
}

document.getElementById('score-filter-type').addEventListener('change', e => {
  if (_scoreModalParticipant) renderScoreEvents(_scoreModalParticipant, e.target.value);
});

function closeScoreModal() {
  document.getElementById('score-modal').style.display = 'none';
}

document.getElementById('btn-score-close').addEventListener('click', closeScoreModal);
document.getElementById('score-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeScoreModal();
});

// ---------------------------------------------------------------------------
// Score Trajectory chart
// ---------------------------------------------------------------------------
let _scoreChart = null;

function openScoreTrajectory() {
  const panel = document.getElementById('score-trajectory');
  panel.style.display = 'flex';
  renderScoreTrajectory();
}

function closeScoreTrajectory() {
  document.getElementById('score-trajectory').style.display = 'none';
  if (_scoreChart) { _scoreChart.destroy(); _scoreChart = null; }
}

function renderScoreTrajectory() {
  if (typeof Chart === 'undefined') return;

  const rangeEl = document.getElementById('score-trajectory-range');
  const range   = rangeEl.value;

  // Collect all rating events across all participants, with running totals
  const participantIds = Object.keys(scoreMap);
  if (participantIds.length === 0) return;

  // Build per-participant time-series: array of { x: eventIndex, y: cumulativeScore }
  const datasets = [];
  const legendEl = document.getElementById('score-trajectory-legend');
  legendEl.innerHTML = '';

  // First, gather ALL events across all participants and sort by timestamp
  let allEvents = [];
  for (const pid of participantIds) {
    const sc = scoreMap[pid];
    if (!sc?.events?.length) continue;
    for (const ev of sc.events) {
      allEvents.push({ pid, score: ev.score, ts: ev.ts || '', event: ev.event, rater: ev.rater });
    }
  }
  allEvents.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));

  // Apply range filter
  if (range === 'last20') allEvents = allEvents.slice(-20);
  else if (range === 'last50') allEvents = allEvents.slice(-50);

  // Build cumulative totals per participant
  const cumulative = {};   // pid → running total
  const series     = {};   // pid → [{ x, y, label }]
  for (const pid of participantIds) {
    cumulative[pid] = 0;
    series[pid]     = [{ x: 0, y: 0 }]; // start at zero
  }

  allEvents.forEach((ev, i) => {
    cumulative[ev.pid] += ev.score;
    // Add data point for the rated participant
    series[ev.pid].push({
      x:     i + 1,
      y:     cumulative[ev.pid],
      label: `${ev.event} (${ev.score > 0 ? '+' : ''}${ev.score}) by ${ev.rater}`
    });
    // Carry forward other participants at this index (so lines extend)
    for (const pid of participantIds) {
      if (pid !== ev.pid && series[pid]) {
        const last = series[pid][series[pid].length - 1];
        if (last.x < i + 1) {
          series[pid].push({ x: i + 1, y: cumulative[pid] });
        }
      }
    }
  });

  // Build Chart.js datasets
  for (const pid of participantIds) {
    if (!series[pid] || series[pid].length <= 1) continue;
    const color = participantColor(pid);
    datasets.push({
      label:           pid,
      data:            series[pid].map(p => ({ x: p.x, y: p.y })),
      borderColor:     color,
      backgroundColor: color + '22',
      borderWidth:     2,
      pointRadius:     3,
      pointHoverRadius: 6,
      fill:            false,
      tension:         0.2,
      _tooltips:       series[pid]
    });

    // Legend entry
    const item = document.createElement('span');
    item.className = 'score-legend-item';
    item.innerHTML = `<span class="score-legend-dot" style="background:${color}"></span>${pid}`;
    legendEl.appendChild(item);
  }

  if (datasets.length === 0) {
    legendEl.innerHTML = '<span style="opacity:.6">No rating events yet</span>';
    return;
  }

  // Destroy previous chart
  if (_scoreChart) _scoreChart.destroy();

  const ctx = document.getElementById('score-trajectory-canvas').getContext('2d');

  // Resolve CSS vars for chart styling
  const cs   = getComputedStyle(document.documentElement);
  const textColor  = cs.getPropertyValue('--text-muted').trim() || '#8892a4';
  const gridColor  = cs.getPropertyValue('--border').trim() || '#2a2d3a';

  _scoreChart = new Chart(ctx, {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'nearest', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (context) => {
              const ds = context.dataset;
              const pt = ds._tooltips?.[context.dataIndex];
              const scoreStr = context.parsed.y > 0 ? `+${context.parsed.y}` : `${context.parsed.y}`;
              return pt?.label ? `${ds.label}: ${scoreStr} — ${pt.label}` : `${ds.label}: ${scoreStr}`;
            }
          }
        }
      },
      scales: {
        x: {
          type: 'linear',
          title: { display: true, text: 'Event #', color: textColor, font: { size: 11 } },
          ticks: { color: textColor, font: { size: 10 }, stepSize: 1 },
          grid: { color: gridColor + '44' }
        },
        y: {
          title: { display: true, text: 'Cumulative Score', color: textColor, font: { size: 11 } },
          ticks: { color: textColor, font: { size: 10 } },
          grid: { color: gridColor + '44' }
        }
      }
    }
  });
}

document.getElementById('btn-score-trajectory').addEventListener('click', () => {
  const panel = document.getElementById('score-trajectory');
  if (panel.style.display === 'flex') closeScoreTrajectory();
  else openScoreTrajectory();
});
document.getElementById('btn-score-trajectory-close').addEventListener('click', closeScoreTrajectory);
document.getElementById('score-trajectory-range').addEventListener('change', () => {
  if (document.getElementById('score-trajectory').style.display === 'flex') renderScoreTrajectory();
});

// ---------------------------------------------------------------------------
// Activity Timeline
// ---------------------------------------------------------------------------
let activityTimelineChart = null;

function openActivityTimeline() {
  document.getElementById('activity-timeline').style.display = 'flex';
  renderActivityTimeline();
}

function closeActivityTimeline() {
  document.getElementById('activity-timeline').style.display = 'none';
  if (activityTimelineChart) { activityTimelineChart.destroy(); activityTimelineChart = null; }
}

function renderActivityTimeline() {
  const bucketMin = parseInt(document.getElementById('activity-timeline-bucket').value, 10);
  const bucketMs  = bucketMin * 60 * 1000;

  if (allEntries.length === 0) return;

  // Determine time range
  const timestamps = allEntries.map(e => new Date(e.timestamp).getTime()).sort((a, b) => a - b);
  const tMin = timestamps[0];
  const tMax = timestamps[timestamps.length - 1];
  const bucketCount = Math.max(1, Math.ceil((tMax - tMin) / bucketMs) + 1);

  // Collect unique authors (agents + humans)
  const authors = [...new Set(allEntries.map(e => e.author))];

  // Build per-author bucket counts
  const datasets = authors.map(author => {
    const counts = new Array(bucketCount).fill(0);
    allEntries.filter(e => e.author === author).forEach(e => {
      const t = new Date(e.timestamp).getTime();
      const idx = Math.min(Math.floor((t - tMin) / bucketMs), bucketCount - 1);
      counts[idx]++;
    });
    return {
      label: author,
      data: counts,
      backgroundColor: participantColor(author) + '99',
      borderColor: participantColor(author),
      borderWidth: 1,
      borderRadius: 2
    };
  });

  // Labels — time of each bucket
  const labels = [];
  for (let i = 0; i < bucketCount; i++) {
    const d = new Date(tMin + i * bucketMs);
    labels.push(d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  }

  // Build legend
  const legendEl = document.getElementById('activity-timeline-legend');
  legendEl.innerHTML = authors.map(a =>
    `<span><span class="legend-dot" style="background:${participantColor(a)}"></span>${a}</span>`
  ).join('');

  // Render stacked bar chart
  if (activityTimelineChart) activityTimelineChart.destroy();
  const ctx = document.getElementById('activity-timeline-canvas').getContext('2d');
  const textColor = getComputedStyle(document.documentElement).getPropertyValue('--text-muted').trim() || '#888';
  const gridColor = getComputedStyle(document.documentElement).getPropertyValue('--border').trim() || '#333';

  activityTimelineChart = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => items[0]?.label || '',
            label: (item) => `${item.dataset.label}: ${item.raw} entries`
          }
        }
      },
      scales: {
        x: {
          stacked: true,
          ticks: { color: textColor, font: { size: 10 }, maxRotation: 45 },
          grid: { color: gridColor + '33' }
        },
        y: {
          stacked: true,
          beginAtZero: true,
          ticks: { color: textColor, font: { size: 10 }, stepSize: 1 },
          grid: { color: gridColor + '33' }
        }
      },
      onClick: (evt, elements) => {
        if (!elements.length) return;
        const idx = elements[0].index;
        const bucketTime = tMin + idx * bucketMs;
        // Find the first entry in this bucket and scroll to it
        const target = allEntries.find(e => {
          const t = new Date(e.timestamp).getTime();
          return t >= bucketTime && t < bucketTime + bucketMs;
        });
        if (target) {
          const el = document.querySelector(`.entry-card[data-id="${target.id}"]`);
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }
    }
  });
}

document.getElementById('btn-activity-timeline').addEventListener('click', () => {
  const panel = document.getElementById('activity-timeline');
  if (panel.style.display === 'flex') closeActivityTimeline();
  else openActivityTimeline();
});
document.getElementById('btn-activity-timeline-close').addEventListener('click', closeActivityTimeline);
document.getElementById('activity-timeline-bucket').addEventListener('change', () => {
  if (document.getElementById('activity-timeline').style.display === 'flex') renderActivityTimeline();
});

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
  if (_initDoneKey) {
    localStorage.setItem(_initDoneKey, '1');
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
  // Build a stable localStorage key from project+session IDs (token may be null)
  _initDoneKey    = data.projectId && data.sessionId
    ? `agentorum_init_done_${data.projectId}:${data.sessionId}`
    : (data.token ? `agentorum_init_done_${data.token}` : null);

  // Filter out interactive agents that have already posted to the chatlog —
  // if an agent has entries it's already initialized and doesn't need the modal.
  const authorSet = new Set(allEntries.map(e => e.author));
  const uninitAgents = data.interactiveParticipants.filter(p => !authorSet.has(p.id));
  _initAgentsData = data.interactiveParticipants;  // keep full list for re-init button

  // Sidebar compact cards (copy buttons only, no modal chrome)
  section.style.display = 'block';
  const container = document.getElementById('init-agent-cards');
  container.innerHTML = '';
  data.interactiveParticipants.forEach(p => {
    const color = participantColor(p.id);
    const initialized = authorSet.has(p.id);
    const card  = document.createElement('div');
    card.className = 'init-agent-card' + (initialized ? ' init-agent-done' : '');
    card.innerHTML = `
      <div class="init-agent-header">
        <span class="init-agent-id" style="color:${color}">${p.id}</span>
        <span class="init-agent-label">${p.label}</span>
        ${initialized ? '<span class="init-agent-check" title="Already initialized">✓</span>' : ''}
      </div>
      <div class="init-command-row">
        <code class="init-command">${p.initCommand}</code>
      </div>
    `;
    const row = card.querySelector('.init-command-row');
    row.appendChild(makeCopyBtn(p.initCommand, 'btn-copy'));
    container.appendChild(card);
  });

  // Auto-show modal ONLY if:
  // 1. autoShow is requested (first load, not manual re-open)
  // 2. user hasn't clicked "Done" for this session (localStorage flag)
  // 3. at least one interactive agent hasn't posted yet
  const alreadyDone = _initDoneKey && localStorage.getItem(_initDoneKey);
  if (autoShow && !alreadyDone && uninitAgents.length > 0) {
    openInitModal(uninitAgents);
  }
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

// Event delegation — rate button and copy button inside entry headers
document.getElementById('entries').addEventListener('click', e => {
  const rateBtn = e.target.closest('.btn-rate-entry');
  if (rateBtn) {
    e.stopPropagation();
    openRateModal(rateBtn.dataset.id);
    return;
  }
  const copyBtn = e.target.closest('.btn-copy-entry');
  if (copyBtn) {
    e.stopPropagation();
    navigator.clipboard.writeText(copyBtn.dataset.body).catch(() => {});
    const orig = copyBtn.textContent;
    copyBtn.textContent = '✓';
    setTimeout(() => { copyBtn.textContent = orig; }, 1200);
    return;
  }
  const delBtn = e.target.closest('.btn-delete-entry');
  if (delBtn) {
    e.stopPropagation();
    const id = delBtn.dataset.id;
    const entry = allEntries.find(e => e.id === id);
    const preview = entry ? `${entry.author}: ${entry.body.slice(0, 80)}${entry.body.length > 80 ? '…' : ''}` : id;
    if (!confirm(`Delete this entry?\n\n${preview}`)) return;
    fetch(`/api/entries/${id}`, { method: 'DELETE' })
      .then(r => r.json())
      .then(data => {
        if (data.ok) {
          allEntries = allEntries.filter(e => e.id !== id);
          const card = document.querySelector(`.entry-card[data-id="${id}"]`);
          if (card) card.remove();
          renderAgentCards();
        } else {
          alert(data.error || 'Delete failed');
        }
      })
      .catch(() => alert('Delete failed'));
  }
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

// Compose textarea auto-resize + word count
(function initComposeResize() {
  const ta = document.getElementById('compose-body');
  const wc = document.getElementById('compose-word-count');
  if (!ta) return;
  function resize() {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 220) + 'px';
  }
  function updateWordCount() {
    const text = ta.value.trim();
    if (!text) { wc.textContent = ''; return; }
    const words = text.split(/\s+/).length;
    const chars = text.length;
    wc.textContent = `${words} word${words !== 1 ? 's' : ''} · ${chars} chars`;
  }
  ta.addEventListener('input', () => { resize(); updateWordCount(); });
  // Reset height when compose bar is cleared after post
  const observer = new MutationObserver(() => { if (!ta.value) { ta.style.height = ''; } });
  observer.observe(ta, { attributes: false, childList: false, characterData: true, subtree: false });
})();

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
  document.getElementById('compose-body').style.height = '';
  document.getElementById('compose-word-count').textContent = '';
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

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------
document.addEventListener('keydown', e => {
  const tag = document.activeElement?.tagName;
  const inInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

  // Ctrl/Cmd+Enter → post compose (works even inside the textarea)
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    const bar = document.getElementById('compose-bar');
    if (bar.style.display !== 'none') {
      e.preventDefault();
      document.getElementById('btn-post').click();
    }
    return;
  }

  // Esc → close topmost open modal / compose bar
  if (e.key === 'Escape') {
    if (document.getElementById('rate-modal').style.display !== 'none')   { closeRateModal();    return; }
    if (document.getElementById('summary-modal').style.display !== 'none') { closeSummaryModal(); return; }
    if (document.getElementById('score-modal').style.display !== 'none')   { closeScoreModal();   return; }
    if (document.getElementById('init-modal').style.display !== 'none')    { closeInitModal();    return; }
    if (document.getElementById('config-modal').style.display !== 'none')  { document.getElementById('config-modal').style.display = 'none'; return; }
    if (document.getElementById('compose-bar').style.display !== 'none')   { document.getElementById('compose-bar').style.display = 'none'; return; }
    return;
  }

  // / → focus search (when not already in an input)
  if (e.key === '/' && !inInput) {
    e.preventDefault();
    document.getElementById('search-input').focus();
  }
});

// ---------------------------------------------------------------------------
// Entry anchor links — scroll to #entry-{id} after initial render
// ---------------------------------------------------------------------------
function scrollToAnchoredEntry() {
  const hash = location.hash;
  if (!hash.startsWith('#entry-')) return;
  const id = hash.slice(1); // entry-{id}
  const card = document.querySelector(`.entry-card[data-id="${id.slice(6)}"]`);
  if (!card) return;
  // Expand it if collapsed
  if (card.classList.contains('collapsed')) toggleCard(card.dataset.id);
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card.classList.add('entry-highlighted');
  setTimeout(() => card.classList.remove('entry-highlighted'), 2500);
}

// ---------------------------------------------------------------------------
// Jump-to-latest button
// ---------------------------------------------------------------------------
(function initJumpToLatest() {
  const chatlog = document.getElementById('chatlog');
  const btn     = document.getElementById('btn-jump-latest');
  if (!chatlog || !btn) return;

  function updateJumpBtn() {
    const distFromBottom = chatlog.scrollHeight - chatlog.scrollTop - chatlog.clientHeight;
    btn.style.display = distFromBottom > 300 ? 'block' : 'none';
  }

  chatlog.addEventListener('scroll', updateJumpBtn, { passive: true });

  btn.addEventListener('click', () => {
    chatlog.scrollTo({ top: chatlog.scrollHeight, behavior: 'smooth' });
  });
})();

// ---------------------------------------------------------------------------
// Session elapsed time
// ---------------------------------------------------------------------------
(function initSessionTimer() {
  const el = document.createElement('span');
  el.id = 'session-elapsed';
  el.title = 'Session duration';
  // Insert into topbar-left after the logo
  const topLeft = document.getElementById('topbar-left');
  if (topLeft) topLeft.appendChild(el);

  function update() {
    if (!allEntries.length) { el.textContent = ''; return; }
    const first = allEntries[0].timestamp;
    if (!first) { el.textContent = ''; return; }
    const start = new Date(first.replace(' ', 'T'));
    const diff  = Date.now() - start.getTime();
    if (isNaN(diff) || diff < 0) { el.textContent = ''; return; }
    const mins  = Math.floor(diff / 60000);
    const hrs   = Math.floor(mins / 60);
    const days  = Math.floor(hrs / 24);
    let label;
    if (days > 0) label = `${days}d ${hrs % 24}h`;
    else if (hrs > 0) label = `${hrs}h ${mins % 60}m`;
    else label = `${mins}m`;
    el.textContent = `· ${label}`;
  }
  setInterval(update, 30000);
  // Also update on first render
  const origRenderAll = renderAll;
  renderAll = function() { origRenderAll(); update(); };
})();

// ---------------------------------------------------------------------------
// Collapsible agents panel
// ---------------------------------------------------------------------------
(function initAgentsToggle() {
  const btn   = document.getElementById('btn-toggle-agents');
  const panel = document.getElementById('agents-panel');
  if (!btn || !panel) return;
  const saved = localStorage.getItem('agentorum_agents_hidden');
  if (saved === '1') { panel.style.display = 'none'; btn.style.opacity = '0.5'; }
  btn.addEventListener('click', () => {
    const hidden = panel.style.display === 'none';
    panel.style.display = hidden ? '' : 'none';
    btn.style.opacity = hidden ? '' : '0.5';
    localStorage.setItem('agentorum_agents_hidden', hidden ? '0' : '1');
  });
})();

// ---------------------------------------------------------------------------
// Dark / light mode toggle
// ---------------------------------------------------------------------------
(function initTheme() {
  const saved = localStorage.getItem('agentorum_theme');
  if (saved) document.documentElement.dataset.theme = saved;
  const btn = document.getElementById('btn-theme');
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

// ---------------------------------------------------------------------------
// Browser notifications for new entries
// ---------------------------------------------------------------------------
function notifyNewEntry(entry) {
  if (document.hasFocus()) return;
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  const p = (serverConfig.participants || []).find(p => p.id === entry.author);
  const name = p?.label || p?.name || entry.author;
  const body = entry.body.length > 120 ? entry.body.slice(0, 117) + '...' : entry.body;
  const n = new Notification(`${name} posted`, { body, tag: 'agentorum-entry' });
  n.onclick = () => { window.focus(); n.close(); };
}

// Request permission on first settings click (non-intrusive)
document.getElementById('btn-settings')?.addEventListener('click', () => {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}, { once: true });

// Boot — patch marked once it is loaded (it loads via CDN after this module)
window.addEventListener('load', () => { patchMarkedForVideo(); scrollToAnchoredEntry(); });
connect();

// When the browser restores this page from bfcache (Back button), the
// WebSocket connection is stale and the page state is frozen mid-session.
// Force a reload so the WS reconnects and the UI reflects current state.
window.addEventListener('pageshow', (e) => {
  if (e.persisted) window.location.reload();
});
