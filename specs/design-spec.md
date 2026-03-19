# Agentorum — Design Specification

**Version:** 0.1 (working draft)
**Status:** Active design — pre-implementation
**Last updated:** 2026-03-18

---

## 1. Vision

Agentorum is a multi-agent deliberation platform. It provides the protocol, the runtime, and the GUI for structured debates between AI agents and humans — where the debate structure is visible, searchable, and auditable, not just a flat chat log.

The core insight is that high-stakes decisions benefit from structured disagreement. A single AI assistant gives one answer. A panel of agents with explicit roles, mandates, and opposing biases surfaces the full argument space — and makes it possible to see where the reasoning is strong and where it is contested.

Agentorum is deliberately domain-agnostic. It was extracted from a coding-specific tool and redesigned to be equally useful for investment analysis, policy deliberation, legal review, clinical discussion, product strategy, and any other domain where structured multi-party reasoning adds value.

The VC investment debate and the policy deliberation are the two primary design reference scenarios. Every architectural decision should be tested against both. Designs that only work for coding or only work for text-heavy domains are out of scope.

---

## 2. Design Principles

**1. The debate is the output, not just the chat.**
The goal is not a chat log — it is a structured argument with visible positions, explicit rebuttals, identified consensus points, and tracked open questions. The GUI must make this structure visible.

**2. Domain-agnostic from day one.**
No hardcoded agent names, no coding-centric terminology, no assumptions about what participants are doing. Everything is configurable: participant names, roles, agent backends, entry types.

**3. Append-only plain text as the source of truth.**
The chatlog is a single Markdown file that every participant appends to. It is human-readable without the GUI, version-controllable with git, and safe for concurrent writes (append-only eliminates most race conditions). The GUI is a view on top of this file, not a replacement for it.

**4. Numbers deserve first-class treatment.**
In many domains the most important evidence is quantitative. Structured data entries (CSV, tables, key-value) must render as interactive tables and charts in the GUI — not as monospaced text blocks. This is a first-class feature, not an afterthought.

**5. Visualization over narration.**
Position maps, stance arcs, thread trees, and live summary panels are more useful than scrolling through 50 messages. The GUI should always offer a structural view alongside the chronological view.

**6. Local-first, zero cloud dependency.**
The server binds to localhost by default. Nothing is sent to an external service. The chatlog is a file on the user's machine. Multi-user and network-exposed modes are deferred to a later version.

**7. Pluggable everything.**
Agent backends (Claude, GPT, Gemini, local models, humans), participant naming schemes, entry types, automation triggers — all are configurable and extensible. No hard dependencies on a specific AI provider.

**8. The format outlasts the GUI.**
The chatlog must be readable and parseable in perpetuity with no special tooling. HTML comment metadata is invisible in rendered Markdown. The core format should be stable from v1.

---

## 3. Use Cases

### 3.1 VC Investment Debate (primary example)

**Scenario:** A venture partnership evaluates a Series A startup. Instead of a single analyst memo, a structured debate between four AI participants produces a richer, more defensible investment thesis.

**Participants:**

| ID | Role | Mandate |
|---|---|---|
| `PARTNER` | Human GP | Facilitates the debate, steers, decides |
| `BULL-VC` | Optimistic agent | Finds the strongest bull case for investment |
| `BEAR-VC` | Skeptical agent | Finds every risk, weakness, and red flag |
| `DUE-DIL` | Analyst agent | Asks factual questions, posts structured financial data |
| `SYNTH` | Synthesizer agent | Summarises the debate state every five turns |

**What this use case exercises:**
- Non-DEV author naming scheme
- Structured data entries (financial projections, TAM tables, CAC comparisons) rendered as live charts
- Stance tracking (bull vs bear sentiment per entry)
- Reply threading (rebuttals target specific claims)
- Synthesizer pattern (periodic auto-summary)
- Binary outcome tracking (invest / pass)

### 3.2 Policy Deliberation (secondary example)

**Scenario:** A policy analyst facilitates a structured debate between AI stakeholder personas on a proposed regulation. The output is a structured map of agreements and disagreements, not a single recommendation.

**Participants:**

| ID | Role | Mandate |
|---|---|---|
| `ANALYST` | Human facilitator | Steers the debate, asks probing questions |
| `ECON` | Economic advisor agent | Assesses cost-benefit, market impact |
| `CIVIL` | Civil-liberties advocate agent | Assesses rights implications |
| `INFRA` | Infrastructure engineer agent | Assesses technical feasibility |
| `SYNTH` | Synthesizer agent | Tracks consensus and open questions |

**What this use case exercises:**
- Multiple non-binary outcomes (consensus / impasse / partial agreement)
- Topic tagging (entries tagged by policy domain)
- Formal mediation roles (facilitator is distinct from participants)
- Position map: spatial view of stakeholder alignment

### 3.3 Development Discussion (retained, not primary)

The original devchat use case — AI coding agents collaborating on a codebase — remains supported. It is not the design reference, but it is a first-class use case. The system must not break it.

---

## 4. Core Protocol

### 4.1 The Chatlog File

The chatlog is a single Markdown file (`chatlog.md` by convention, configurable) that all participants share. It is:

- **Append-only** — new entries are always added at the end; existing entries are never modified or deleted
- **Plain text** — readable in any text editor, renderable in any Markdown viewer
- **Version-controllable** — safe to commit to git; the append-only property means concurrent writes are safe via `fs.appendFile`
- **The source of truth** — the GUI state is derived from this file; the file can outlast the GUI

### 4.2 Entry Parsing

The server continuously monitors the chatlog for new entries. It parses them by scanning for level-3 headings matching the pattern `### YYYY-MM-DD HH:MM:SS - AUTHOR-ID`. Everything between one such heading and the next is the entry body.

Entries are identified by a stable ID derived from a SHA-256 hash of the header line (timestamp + author). This ID does not appear in the file — it is computed on parse. This means entry IDs are stable across re-reads and across machines.

### 4.3 Writing Entries

Any participant (human via GUI, agent via watcher, automation rule) appends entries using the format defined in Section 5. Writes use `fs.appendFile` to avoid overwriting concurrent writes. No locking is required — append is atomic at the OS level for reasonable entry sizes.

### 4.4 Watcher / Agent Loop

Each agent participant is backed by a watcher process (`watcher/watch.mjs`) that:

1. Monitors `chatlog.md` for changes using `fs.watch`
2. On change, re-parses the file and diffs against last known state
3. Checks the new entry against its `respondTo` filter (which authors should trigger this agent)
4. Checks that the last entry was not written by itself (self-echo guard)
5. Invokes the configured agent backend (shell command, API call, etc.)
6. Appends the agent's response as a new entry

Loop prevention is three-fold:
- **Content hash dedup** — same file hash as last read → skip
- **Self-echo guard** — last entry author == this agent → skip
- **Respond-to filter** — only react to configured authors

---

## 5. Entry Format

### 5.1 Base Format

```markdown
### YYYY-MM-DD HH:MM:SS - AUTHOR-ID
<!-- meta: { JSON object } -->

Entry body in Markdown.
```

The header line is the only required element. The metadata comment and body are optional. An entry with only a header and a blank line is valid.

**Author ID format:** Uppercase alphanumeric string, hyphens allowed. Examples: `BULL-VC`, `PARTNER`, `SYNTH`, `ECON`. No spaces. No special characters beyond hyphens. The convention `DEV#N` from the original codebase is deprecated in favour of descriptive role names.

### 5.2 Metadata Block

The metadata block is an HTML comment on the line immediately following the header. It is invisible in rendered Markdown and ignored by parsers that don't understand it.

```
<!-- meta: { ...fields... } -->
```

The comment must be on a single line. The JSON must be valid. Parsers must treat malformed metadata as absent — they must not reject the entry.

**Reserved fields (v1 spec, implementation deferred to v2 unless noted):**

| Field | Type | Status | Description |
|---|---|---|---|
| `type` | string | v1 spec | Entry type. See Section 5.3. |
| `replyTo` | string | **v1 implement** | Header string of the entry this replies to: `"YYYY-MM-DD HH:MM:SS - AUTHOR-ID"`. Enables thread view. |
| `stance` | string | v1 spec | Deliberation stance: `"bull"`, `"bear"`, `"neutral"`, `"mediator"`, `"synthesis"`. Domain-configurable. |
| `tags` | string[] | v1 spec | Topic tags. Free-form strings. Example: `["team", "market-size", "cac"]`. |
| `topic` | string | v1 spec | Primary topic label for grouping and filtering. |
| `certainty` | number | v2 | 0–1 confidence the author assigns to the claim. |
| `targets` | string[] | v2 | For rebuttals: list of `replyTo`-format strings being rebutted. |
| `consensus` | string[] | v2 | For synthesis entries: list of points on which consensus has been reached. |
| `open` | string[] | v2 | For synthesis entries: list of unresolved open questions. |
| `outcome` | string | v2 | For decision entries: `"invest"`, `"pass"`, `"defer"`, `"consensus"`, `"impasse"`. |
| `format` | string | **v1 implement** | For data entries: `"csv"`, `"tsv"`, `"kv"`. Triggers spreadsheet rendering. |
| `title` | string | **v1 implement** | For data entries: display title for the table/chart. |
| `chart` | string | **v1 implement** | For data entries: chart type. `"bar"`, `"line"`, `"pie"`, `"scatter"`. |

Fields marked **v1 implement** must be implemented in the GUI in v1. Fields marked "v1 spec" must be defined in this specification and reserved in parsers (unknown fields must be preserved, not stripped), but their UI implementation is deferred to v2.

### 5.3 Entry Types

The `type` field classifies what an entry is doing in the debate. Supported types:

| Type | Description |
|---|---|
| `claim` | Asserts a position or piece of evidence |
| `rebuttal` | Directly challenges a prior claim |
| `question` | Poses a question to one or more participants |
| `answer` | Responds to a question |
| `synthesis` | Summarises the current state of the debate (typically posted by `SYNTH`) |
| `data` | Posts structured quantitative data (CSV/table); rendered as live spreadsheet + chart |
| `decision` | Records a final outcome or decision |
| `procedural` | A housekeeping entry (e.g., "pausing the debate", "changing topic") |

If `type` is absent, the entry is treated as a generic `claim` for display purposes.

### 5.4 Example: VC Debate Entries

**Claim:**
```markdown
### 2026-03-18 14:05:00 - BULL-VC
<!-- meta: {"type": "claim", "stance": "bull", "tags": ["team", "track-record"]} -->

The founding team's previous exit (Series B, acquired for $180M in 2022) is unusually strong
for a pre-revenue Series A. Both founders have built and sold companies before.
```

**Data entry (renders as live table + chart):**
```markdown
### 2026-03-18 14:12:00 - DUE-DIL
<!-- meta: {"type": "data", "format": "csv", "title": "Revenue Projections (3-year)", "chart": "bar", "replyTo": "2026-03-18 14:05:00 - BULL-VC"} -->

Year,Conservative,Base Case,Optimistic
2026,$1.8M,$2.1M,$2.5M
2027,$4.5M,$6.3M,$9.0M
2028,$10.0M,$15.0M,$22.0M
```

**Rebuttal:**
```markdown
### 2026-03-18 14:18:00 - BEAR-VC
<!-- meta: {"type": "rebuttal", "stance": "bear", "replyTo": "2026-03-18 14:12:00 - DUE-DIL", "tags": ["market-size", "tam"]} -->

The base-case projection requires 8% market penetration by year 3 in an enterprise segment
they have never sold into. The $4B TAM figure includes adjacent markets they cannot reach
without a direct sales motion they don't currently have.
```

**Synthesis:**
```markdown
### 2026-03-18 14:30:00 - SYNTH
<!-- meta: {"type": "synthesis", "stance": "synthesis"} -->

**Current state after 8 turns:**

Both sides agree: team quality is strong; technology differentiation is real.

Bull case rests on: track record, early traction ($280K ARR), defensible IP.

Bear case rests on: enterprise GTM gap, TAM defensibility, CAC unknown.

Open question: Is the $4B TAM figure defensible when limited to the SMB segment only?
```

---

## 6. Participant Model

### 6.1 Participant Configuration

Each participant is defined in the configuration file (`ui-config.json`). Required fields:

```json
{
  "id": "BULL-VC",
  "label": "Bull Case Partner",
  "color": "#2D7DD2",
  "backend": "claude",
  "respondTo": ["PARTNER", "BEAR-VC", "DUE-DIL"],
  "systemPrompt": "You are an optimistic venture partner. Your job is to find the strongest possible bull case for investment in the startup under discussion. Be specific. Use numbers. Challenge the bear case directly.",
  "automationRules": []
}
```

Optional fields:

| Field | Description |
|---|---|
| `stance` | Default stance for entries from this participant: `bull`, `bear`, `neutral`, `mediator`, `synthesis` |
| `role` | Human-readable role label shown in the GUI |
| `autoTrigger` | If `true`, this participant is triggered automatically by its `respondTo` filter |
| `delayMs` | Delay between trigger and invocation (default: 3000ms) |
| `maxTurns` | Maximum consecutive turns without a human entry (loop guard) |

### 6.2 Agent Backends

Agent backends are pluggable. The watcher invokes a shell command or API call and appends the result as a new entry. Built-in backends:

| Backend ID | Description |
|---|---|
| `claude` | Invokes `claude --print` with the chatlog as context |
| `openai` | Invokes the OpenAI API (chat completion) |
| `ollama` | Invokes a local Ollama model |
| `shell` | Runs an arbitrary shell command; stdout becomes the entry body |
| `human` | No automated invocation; waits for human input via the GUI |

Custom backends are defined as shell commands in the configuration:

```json
{
  "backend": "shell",
  "command": "python3 ./agents/bull-vc-agent.py"
}
```

The watcher passes context to the agent backend via:
- Stdin: the full chatlog content (or a configurable window of recent entries)
- Environment variables: `AGENTORUM_AUTHOR`, `AGENTORUM_CHATLOG_PATH`, `AGENTORUM_RULES_PATH`

### 6.3 The Synthesizer Pattern

The `SYNTH` participant is a special-purpose agent that periodically summarises the debate state. It is not a debater — it has no stance. Its system prompt instructs it to:

1. Identify claims made by each participant
2. Identify points of agreement (both sides have conceded or not contested)
3. Identify the strongest open question
4. Summarise in a structured format (not prose)

`SYNTH` is triggered by an automation rule, not by specific authors — typically every N entries, or whenever a human participant posts. It posts entries with `type: synthesis`.

The GUI uses `SYNTH` entries as anchor points for the debate summary panel. The most recent synthesis entry is displayed in the summary sidebar.

---

## 7. Architecture

### 7.1 Package Structure

```
agentorum/
├── packages/
│   ├── server/           # @agentorum/server
│   │   ├── server.mjs    # HTTP + WebSocket server, ChatlogWatcher, AgentManager, AutomationEngine
│   │   └── package.json  # dep: ws only
│   ├── watcher/          # @agentorum/watcher
│   │   ├── watch.mjs     # Cross-platform file watcher + agent invocation loop
│   │   └── package.json  # no external deps
│   └── client/           # @agentorum/client
│       ├── index.html
│       ├── app.js        # Vanilla JS, ES modules, no build step
│       ├── style.css
│       └── package.json
├── examples/
│   ├── vc-debate/        # Complete VC investment debate example
│   │   ├── ui-config.json
│   │   ├── rules.txt
│   │   └── README.md
│   └── policy-mediation/ # Stakeholder policy deliberation example
│       ├── ui-config.json
│       ├── rules.txt
│       └── README.md
├── specs/
│   └── design-spec.md    # This document
├── package.json          # npm workspaces root
└── README.md
```

Consuming projects install the packages:

```json
{
  "dependencies": {
    "@agentorum/server": "^1.0.0",
    "@agentorum/watcher": "^1.0.0"
  }
}
```

and provide a thin launcher + config file pointing at their chatlog path and participant definitions. The client is served as static files by the server; consuming projects do not need to copy it.

### 7.2 Server Components

The server (`packages/server/server.mjs`) is a single Node.js process with no framework dependencies beyond `ws`:

**ChatlogWatcher** — monitors `chatlog.md` with `fs.watch`; on change, re-parses the file, diffs against last known state (by stable entry ID), broadcasts new entries via WebSocket. Deduplicates by SHA-256 content hash.

**AgentManager** — spawns and monitors watcher child processes per participant; tracks status (running / stopped / last-response-at); streams stdout to the GUI via WebSocket as live log lines.

**AutomationEngine** — on each new entry, evaluates automation rules; if a rule matches (trigger condition satisfied), schedules the target agent's watcher invocation after the configured delay.

**REST Router** — handles all HTTP endpoints (see Section 7.4).

**WebSocket Hub** — broadcasts to all connected clients: new entries, agent status changes, live agent log lines, config updates, keepalive pings.

### 7.3 Network Configuration

Default: binds to `127.0.0.1:3737`. Not exposed to the network by default. Port is configurable in `ui-config.json`.

No authentication in v1 (single-user, localhost). Authentication and network-exposed mode are v2 features.

### 7.4 REST API

| Method | Path | Description |
|---|---|---|
| GET | `/api/entries` | All entries. `?before=TIMESTAMP&limit=N` for pagination. `?type=claim` to filter by entry type. |
| POST | `/api/entries` | Append a new entry. Body: `{ author, body, meta? }` |
| GET | `/api/agents` | All participant statuses |
| POST | `/api/agents/:id/start` | Start the watcher for participant `:id` |
| POST | `/api/agents/:id/stop` | Stop the watcher for participant `:id` |
| POST | `/api/agents/:id/trigger` | One-shot invocation of participant `:id` |
| GET | `/api/config` | Current configuration |
| PUT | `/api/config` | Update configuration (persisted to file) |
| GET | `/api/rules` | All automation rules |
| POST | `/api/rules` | Add automation rule |
| PUT | `/api/rules/:id` | Update automation rule |
| DELETE | `/api/rules/:id` | Delete automation rule |
| GET | `/api/summary` | Most recent synthesis entry (for summary panel) |

### 7.5 WebSocket Events

Server → client:

| Event | Payload |
|---|---|
| `init` | Full current state on connect: entries (last 500), agents, config, rules |
| `entries_added` | Array of new parsed entries |
| `agent_status` | Updated status object for one participant |
| `agent_log` | One stdout line from a running agent: `{ agentId, line }` |
| `config_updated` | Updated config object |
| `ping` | Keepalive (client responds `pong`) |

Client → server:

| Event | Description |
|---|---|
| `pong` | Keepalive response |
| `request_entries_before` | Request older entries (pagination) |

---

## 8. GUI Design

### 8.1 Layout

Three-panel layout, responsive:

```
┌────────────────────────────────────────────────────────────────────┐
│ TOPBAR: Logo | Participant Pills | Search | Summary toggle | Config │
├──────────┬──────────────────────────────────┬──────────────────────┤
│          │                                  │                      │
│ SIDEBAR  │  MAIN AREA                       │  RIGHT PANEL         │
│          │                                  │                      │
│ Filters  │  [View toggle: Thread | Timeline │  Participants        │
│ Authors  │   | Position Map | Spreadsheet]  │  ·BULL-VC ● running  │
│ Dates    │                                  │  ·BEAR-VC ● running  │
│ Types    │  ┌──────────────────────────┐   │  ·DUE-DIL ○ stopped  │
│ Stance   │  │ Entry cards (scrollable) │   │  ·SYNTH   ● running  │
│          │  │ or Thread tree view      │   │                      │
│ SUMMARY  │  │ or Position map          │   │  Automation Rules    │
│ PANEL    │  │ or Spreadsheet grid      │   │  · PARTNER→SYNTH     │
│          │  └──────────────────────────┘   │  · [+ Add rule]      │
│ (live    │                                  │                      │
│  debate  │  [Compose box]                  │  Agent Log (drawer)  │
│  state)  │                                  │                      │
└──────────┴──────────────────────────────────┴──────────────────────┘
```

Below 900px: sidebar and right panel collapse to tabs.

### 8.2 Entry Cards

Each entry renders as a card with:

- **Header bar:** Author pill (coloured by participant), timestamp, timeago label, entry type badge, stance badge (bull/bear/neutral/synthesis)
- **Collapse toggle:** Click header to collapse/expand. Collapsed: 2-line snippet + line count
- **Body:** Full Markdown rendering (via `marked`)
- **Freshness indicators:** "● Live" (under 45s), "New" (under 5min) — coloured border matching author colour
- **Reply indicator:** If `replyTo` is set, a small "↩ replying to AUTHOR-ID" link that scrolls to the parent entry
- **Data card variant:** If `type === "data"`, renders the body as a live table + chart instead of Markdown prose (see Section 8.5)

### 8.3 View Modes

The main area supports four view modes, toggled via tabs at the top of the main panel:

**Timeline (default)** — chronological list of entry cards. The standard chat log view. Newest at bottom, auto-scroll unless user has scrolled up more than 180px.

**Thread view** — entry cards arranged as a reply tree. Entries with no `replyTo` are top-level. Entries with `replyTo` are indented under their parent. Renders the debate as an argument tree, not a chronological list. Collapsing a parent collapses its entire subtree.

**Position map** — a force-directed graph (v2) showing participants as nodes and their alignment or opposition as edges. Entries with `replyTo` create directed edges. Stance similarity pulls nodes together; opposition pushes them apart.

**Spreadsheet** — a dedicated view for all `type: data` entries. Each data entry is displayed as a full-width table with its associated chart. Non-data entries are hidden in this view. Charts can be enlarged. Data can be exported as CSV.

### 8.4 Sidebar

**Filters (always visible):**
- Filter by author (checkbox per participant)
- Filter by date range (date pickers)
- Filter by entry type (multi-select: claim, rebuttal, question, synthesis, data, decision)
- Filter by stance (bull / bear / neutral / synthesis / mediator)
- "New only" toggle
- "Has data" toggle (entries with type: data)

All filters are AND-combined. Filters are session-level (not persisted).

**Summary panel (toggleable):**
A persistent section at the bottom of the sidebar showing the current debate state, derived from the most recent `type: synthesis` entry:

```
DEBATE STATE
────────────────
Agreed: team quality, tech differentiation
Bull case: track record, early ARR
Bear case: GTM gap, TAM defensibility
Open: Is the $4B TAM defensible for SMB only?
────────────────
Last updated: SYNTH · 8 min ago
```

Clicking "Last updated" scrolls to that synthesis entry in the main panel. If no synthesis entry exists, the panel shows "No synthesis yet — trigger SYNTH to generate one."

### 8.5 Live Data Spreadsheet

When an entry has `type: "data"` and `format: "csv"` (or `"tsv"`), the entry card renders the body as:

1. **A sortable, interactive table** — columns derived from the CSV header row; rows are data rows; clicking column headers sorts ascending/descending
2. **A chart** — type determined by the `chart` field in metadata (`bar`, `line`, `pie`, `scatter`); rendered using Chart.js (loaded from CDN, no build step); title from the `title` metadata field
3. **An expand button** — enlarges the chart to full-width overlay
4. **A CSV download button** — exports the raw CSV data

Multiple data entries can coexist in the log. The Spreadsheet view mode shows all data entries as full-width cards, stacked vertically, each with its own table and chart. This view is designed for number-heavy domains where quantitative evidence is the primary content.

Charts re-render whenever a new data entry is added (the chart is not interactive across entries — each entry owns its own chart). Cross-entry comparison charts (combining data from multiple entries) are a v2 feature.

**Key-value data format (`format: "kv"`):**

For simple named-value data (e.g., key metrics summary), a key-value format renders as a two-column table:

```
CAC,$1,200
LTV,$8,400
LTV/CAC,7.0x
Churn (monthly),1.8%
Gross Margin,74%
```

Rendered as a compact two-column table with no chart (chart type ignored for `kv`).

### 8.6 Stance Arc

A horizontal timeline chart showing how `stance` values have been distributed across entries over time (v1 spec, v2 implement):

```
Turn:  1    3    5    7    9    11   13
Bull:  ████ ████ ███  ████ ████ ████ █████
Bear:  ████ ████ █████████  ███  ██   ██
Neut:  ██   ██   ██   ██   ███  ████ ███
```

Displayed as a stacked bar chart or area chart in the right panel below the participant cards. Provides an at-a-glance sense of debate momentum — is the bull or bear case gaining ground?

### 8.7 Right Panel — Participants

Each participant has a card in the right panel:

- **Status indicator:** ● running, ○ stopped, ◌ idle (running but no response in 10+ min)
- **Last response:** timeago label ("3 min ago")
- **Actions:** Start / Stop / Trigger (one-shot invoke) / View Log
- **Log drawer:** slide-out showing last 500 lines of agent stdout

Below participant cards: **Automation Rules** section, with enable/disable toggles, rule labels, and a `+ Add Rule` button.

### 8.8 Compose Box

Anchored at the bottom of the main area (toggle visibility via keyboard shortcut or button):

- **Author selector:** dropdown of all participants (defaults to the human participant)
- **Entry type selector:** dropdown (claim, rebuttal, question, answer, data, procedural)
- **Reply-to field:** optional; prefilled when clicking a "Reply" button on an entry card
- **Body textarea:** Markdown-enabled; live preview toggle (split-pane)
- **Data mode:** if entry type is `data`, body textarea switches to a CSV editor with format selector and chart type selector
- **Metadata preview:** collapsible section showing the generated metadata comment before posting
- **Submit:** `Ctrl+Enter` or button; posts via `POST /api/entries`

### 8.9 Theming

Light and dark themes via `prefers-color-scheme` media query. All participant colours are defined in the config and must meet WCAG AA contrast ratios in both themes. A default colour palette of eight colours is provided; custom colours can be set per participant.

---

## 9. Automation Rules

Automation rules define when a participant is triggered automatically. Each rule has:

```json
{
  "id": "uuid",
  "enabled": true,
  "label": "PARTNER → SYNTH every 5 turns",
  "trigger": {
    "type": "entry_from",
    "author": "PARTNER"
  },
  "action": {
    "type": "trigger_agent",
    "agentId": "SYNTH",
    "delayMs": 5000
  }
}
```

**Trigger types (v1):**

| Type | Description |
|---|---|
| `entry_from` | Fires when a new entry is posted by the specified author |
| `every_n_entries` | Fires after every N new entries (regardless of author) |

**Action types (v1):**

| Type | Description |
|---|---|
| `trigger_agent` | Invokes the specified participant's watcher (one-shot) |

**v2 trigger types (deferred):**

- `entry_of_type` — fires on entries with a specific `type` value
- `stance_imbalance` — fires when one stance dominates recent entries by a configured ratio
- `no_synthesis_in_n` — fires when no synthesis entry has appeared in N turns (auto-triggers SYNTH)
- `schedule` — fires on a cron-like schedule

---

## 10. Configuration File

`ui-config.json` (stored alongside the chatlog, gitignored by default):

```json
{
  "chatlog": ".private/devchats/chatlog.md",
  "rules": ".private/devchats/rules.txt",
  "port": 3737,
  "participants": [
    {
      "id": "PARTNER",
      "label": "General Partner",
      "color": "#555555",
      "backend": "human",
      "stance": "mediator"
    },
    {
      "id": "BULL-VC",
      "label": "Bull Case Partner",
      "color": "#2D7DD2",
      "backend": "claude",
      "stance": "bull",
      "respondTo": ["PARTNER", "BEAR-VC"],
      "systemPrompt": "..."
    },
    {
      "id": "BEAR-VC",
      "label": "Bear Case Partner",
      "color": "#E63946",
      "backend": "claude",
      "stance": "bear",
      "respondTo": ["PARTNER", "BULL-VC"],
      "systemPrompt": "..."
    },
    {
      "id": "SYNTH",
      "label": "Synthesizer",
      "color": "#8338EC",
      "backend": "claude",
      "stance": "synthesis",
      "respondTo": [],
      "systemPrompt": "..."
    }
  ],
  "automationRules": [
    {
      "id": "rule-1",
      "enabled": true,
      "label": "PARTNER → BULL-VC",
      "trigger": { "type": "entry_from", "author": "PARTNER" },
      "action": { "type": "trigger_agent", "agentId": "BULL-VC", "delayMs": 3000 }
    },
    {
      "id": "rule-2",
      "enabled": true,
      "label": "PARTNER → BEAR-VC",
      "trigger": { "type": "entry_from", "author": "PARTNER" },
      "action": { "type": "trigger_agent", "agentId": "BEAR-VC", "delayMs": 6000 }
    },
    {
      "id": "rule-3",
      "enabled": true,
      "label": "Every 5 entries → SYNTH",
      "trigger": { "type": "every_n_entries", "n": 5 },
      "action": { "type": "trigger_agent", "agentId": "SYNTH", "delayMs": 2000 }
    }
  ]
}
```

---

## 11. v1 Scope Boundary

| Feature | v1 | v2+ | Notes |
|---|---|---|---|
| Append-only Markdown chatlog | ✓ | | |
| Entry format + metadata comment spec | ✓ (spec) | | Locked in v1 even where UI is deferred |
| `replyTo` threading + thread view | ✓ | | Required for visualization |
| `type` and `stance` fields (spec) | ✓ (spec) | ✓ (UI) | Spec locked v1; rendering is v2 |
| Configurable participant names and colors | ✓ | | No hardcoded DEV#N |
| Pluggable agent backends (shell command) | ✓ | | |
| Claude + OpenAI backends | ✓ | | |
| Local Node.js HTTP + WebSocket server | ✓ | | |
| Timeline view | ✓ | | |
| Thread view | ✓ | | Requires replyTo |
| Live data entries (CSV → table + chart) | ✓ | | Chart.js, bar/line/pie/scatter |
| Compose box with data mode | ✓ | | |
| Automation rules (entry_from, every_n) | ✓ | | |
| Agent start/stop/trigger/log | ✓ | | |
| Full-text search | ✓ | | |
| Filters (author, type, date) | ✓ | | |
| Debate summary panel (from SYNTH entries) | ✓ | | |
| npm workspace package structure | ✓ | | |
| VC debate example | ✓ | | |
| Policy mediation example | ✓ | | |
| Stance arc visualization | spec | ✓ impl | |
| Position map (force graph) | | ✓ | |
| Cross-entry chart comparison | | ✓ | |
| Metadata UI (display, filter, edit) | filter only | ✓ full | |
| Multi-user / auth | | ✓ | |
| Network-exposed mode | | ✓ | |
| Advanced trigger types | | ✓ | |
| Outcome / decision tracking | | ✓ | |
| Entry editing / deletion | | ✓ | Breaks append-only; needs careful design |

---

## 12. Security Model

**v1 (localhost only):**
- Server binds to `127.0.0.1`, not `0.0.0.0`
- No authentication; assumes single-user local access
- API keys for AI backends stay server-side; never sent to the browser
- Chatlog is append-only via API; no delete or edit endpoint in v1
- No user-supplied input reaches shell commands without sanitization

**Known limitations (deferred to v2):**
- No auth = any process on the local machine can post entries or trigger agents
- Port binding on 3737 is predictable; a malicious local process could interfere

---

## 13. Platform and Distribution Decisions

### 13.1 Mobile Strategy (decided)

**Decision: one responsive web app + PWA. No separate native apps.**

Rationale:
- Agentorum is read-heavy and text-dense. Native APIs (camera, haptics, background audio) are not relevant.
- Maintaining three codebases (desktop, iOS, Android) for a small open-source project is not viable.
- App Store review cycles, sandboxing, and 30% cut conflict with the open-source, zero-cost model.
- The primary mobile use case is monitoring a debate in progress — a viewer role, not a primary input role. This is well served by a browser tab or PWA.

**Implementation:**
- CSS responsive breakpoints: three-panel layout collapses to single-column below 900px. Sidebar and right panel become bottom-sheet drawers.
- PWA manifest (`manifest.json`) + service worker added in v1. Users can pin to home screen on both Android and iOS (full-screen, no browser chrome).
- Known iOS Safari quirks to handle in v1: viewport height with on-screen keyboard, `env(safe-area-inset-bottom)` for the swipe bar, `font-size` zoom-on-focus (suppress with `touch-action` + meta viewport).
- Touch targets: minimum 44×44px for all interactive controls per WCAG 2.5.5.

**Deferred:** If a specific native capability becomes necessary (e.g., push notifications for new debate rounds), Capacitor can wrap the existing HTML/CSS/JS with minimal rework. The responsive layer built in v1 is the foundation for this.

### 13.2 Desktop Distribution (decided)

**Decision: Electron wrapper for Windows/macOS/Linux. No separate codebases.**

Rationale:
- The existing stack is Node.js (server) + vanilla HTML/JS/CSS (client). Electron can bundle both the server and the browser UI into a single executable with no rewrite.
- Electron is the standard path for Node.js desktop apps and is well-understood by open-source contributors.
- Alternative (pkg/nexe) bundles only the Node.js server; users would still need to open a browser manually. Electron gives a single-window experience that is more appropriate for non-technical users.

**Implementation:**
- A thin `packages/desktop/` Electron shell launches the server process and opens a `BrowserWindow` pointed at `localhost:3737`.
- Distribution: GitHub Releases with `electron-builder` producing `.exe` (Windows), `.dmg` (macOS), `.AppImage` (Linux).
- Auto-update via `electron-updater` pulling from GitHub Releases.
- Users who prefer the server-only mode can continue to use `npm start` and open a browser manually — the Electron shell is additive, not a replacement.

**Deferred:** Code signing for macOS notarization and Windows SmartScreen requires paid developer accounts. v1 ships unsigned; signed builds are a v1.x milestone once the project has a maintainer identity.

---

## 15. Open Questions

**Repo name:** Working name is `khub-devchat`. Candidate: `agentorum` (no existing npm package; clearly signals multi-agent forum/deliberation; avoids coding-centric read of "devchat"). Decision pending.

**NPM scope:** `@khub/agentorum` or `@agentorum/server` etc. Depends on whether this lives under the khub org or as a standalone org.

**Chatlog migration:** When the format evolves (e.g., adding new reserved metadata fields), existing chatlogs must remain parseable. The parser must be lenient: unknown metadata fields are preserved verbatim, not stripped. This must be a hard constraint from v1.

**Agent response length:** Long agent responses degrade the timeline view. Should the GUI truncate card previews aggressively? Should there be a recommended max-length guideline in `rules.txt`? Open.

**Data entry versioning:** If `DUE-DIL` posts an updated revenue projection, does it replace the prior data entry in the Spreadsheet view, or appear as a separate entry? Current answer: separate entry (append-only), displayed in order. "Latest version" tracking is v2.

**SYNTH trigger strategy:** Auto-trigger every N entries works but may be wasteful. Smarter trigger (e.g., when stance imbalance exceeds a threshold, or when no rebuttal appears within K turns) is v2. v1 uses every_n_entries with configurable N.
