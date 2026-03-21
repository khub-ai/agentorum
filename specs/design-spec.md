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

**9. Mandatory actions are never silent.**
If the user must do something before the session will work correctly — initialize an agent, provide an API key, resolve a conflict — the UI must surface this as a blocking modal dialog, not a sidebar hint or passive label. Silent failures and missed setup steps are a primary cause of user frustration in developer tools. The rule: anything the user *must* do gets a modal; anything the user *may* do gets a panel or inline control. This principle applies to all future features.

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

@key: value
@key2: value2

Entry body in Markdown.
```

The header line is the only required element. Metadata lines and the body are optional. An entry with only a header and a blank line is valid.

**Entry ID:** Each entry is assigned a stable identifier computed as the first 16 hex characters of `SHA-256(timestamp + ":" + author + ":" + raw_content)`. Including the raw content in the hash makes the ID collision-proof: two entries from the same author in the same second — possible from rapid posts, retries, or overlapping automation — will always have different content and therefore different IDs. The ID is stable across server restarts because the chatlog is append-only and the content of an existing entry never changes.

**Author ID format:** Uppercase alphanumeric string, hyphens allowed. Examples: `BULL-VC`, `PARTNER`, `SYNTH`, `ECON`. No spaces. No special characters beyond hyphens. The convention `DEV#N` from the original codebase is deprecated in favor of descriptive role names.

### 5.2 Metadata Block

Metadata is expressed as `@key: value` lines immediately following the header, before the body. Each line contains exactly one key-value pair. Lines are parsed in order until the first non-`@` line, which begins the body.

```
### YYYY-MM-DD HH:MM:SS - AUTHOR-ID

@type: claim
@stance: bull
@replyTo: 2026-03-18 14:05:00 - BEAR-VC

Entry body begins here.
```

Metadata keys are lowercase alphanumeric. Values are plain strings. Parsers must treat unrecognized keys as unknown but preserve them — unknown keys must not cause the entry to be rejected or the metadata to be discarded.

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
| `rating` | A structured score event targeting another participant. See Section 18 for full spec. Must include `@target`, `@event`, and `@entryRef` metadata fields. Not rendered as a normal chat entry — contributes to participant scores only. |

If `type` is absent, the entry is treated as a generic `claim` for display purposes.

`rating` entries are the only type that carry cross-entry references (`@entryRef`). Parsers must handle a missing or invalid `@entryRef` gracefully — the rating still contributes to the participant's score, it just cannot be linked to a specific entry card in the GUI.

### 5.4 Example: VC Debate Entries

**Claim:**
```markdown
### 2026-03-18 14:05:00 - BULL-VC

@type: claim
@stance: bull
@tags: team,track-record

The founding team's previous exit (Series B, acquired for $180M in 2022) is unusually strong
for a pre-revenue Series A. Both founders have built and sold companies before.
```

**Data entry (renders as live table + chart):**
```markdown
### 2026-03-18 14:12:00 - DUE-DIL

@type: data
@format: csv
@title: Revenue Projections (3-year)
@chart: bar
@replyTo: 2026-03-18 14:05:00 - BULL-VC

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
agentorum/                             ← repo root
├── packages/
│   ├── server/                        # @agentorum/server
│   │   ├── server.mjs                 # HTTP + WebSocket server, ChatlogWatcher, AgentManager, AutomationEngine
│   │   └── package.json               # dep: ws only
│   ├── watcher/                       # @agentorum/watcher
│   │   ├── watch.mjs                  # Cross-platform file watcher + agent invocation loop
│   │   └── package.json               # no external deps
│   ├── client/                        # @agentorum/client
│   │   ├── index.html                 # Project browser home screen
│   │   ├── session.html               # Session (debate) view
│   │   ├── app.js                     # Vanilla JS, ES modules, no build step
│   │   ├── style.css
│   │   └── package.json
│   └── desktop/                       # @agentorum/desktop (Electron shell)
│       ├── main.js                    # Launches server + opens BrowserWindow
│       └── package.json
├── scenarios/                         # Built-in reusable scenario templates
│   ├── vc-debate.scenario.json
│   ├── policy-mediation.scenario.json
│   └── code-review.scenario.json
├── examples/
│   ├── vc-debate/                     # Runnable VC debate example
│   │   ├── agentorum.config.json
│   │   ├── rules.txt
│   │   └── README.md
│   └── policy-mediation/              # Runnable policy mediation example
│       ├── agentorum.config.json
│       ├── rules.txt
│       └── README.md
├── usecases/                          # Detailed use cases with sample results
├── specs/
│   └── design-spec.md                 # This document
├── package.json                       # npm workspaces root
└── README.md
```

**User workspace** (outside the repo, on the user's machine):

```
~/.agentorum/                          ← workspace root (configurable)
├── workspace.json                     ← workspace name, created date, settings
├── scenarios/                         ← user-defined scenario templates (added to built-ins)
│   └── my-custom-debate.scenario.json
└── projects/
    ├── vc-portfolio-q1-2026/
    │   ├── project.json               ← name, description, default scenario ref
    │   └── sessions/
    │       ├── techco-series-a/
    │       │   ├── session.json       ← name, created, scenario used, override fields
    │       │   ├── chatlog.md
    │       │   └── agentorum.config.json  ← resolved config (scenario + overrides merged)
    │       └── biospark-series-b/
    │           ├── session.json
    │           ├── chatlog.md
    │           └── agentorum.config.json
    └── policy-review-2026/
        ├── project.json
        └── sessions/
            └── data-retention-reg/
                ├── session.json
                ├── chatlog.md
                └── agentorum.config.json
```

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

- **Header bar:** Author pill (colored by participant), timestamp, timeago label, entry type badge, stance badge (bull/bear/neutral/synthesis)
- **Collapse toggle:** Click header to collapse/expand. Collapsed: 2-line snippet + line count
- **Body:** Full Markdown rendering (via `marked`)
- **Freshness indicators:** "● Live" (under 45s), "New" (under 5min) — colored border matching author color
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

Light and dark themes via `prefers-color-scheme` media query. All participant colors are defined in the config and must meet WCAG AA contrast ratios in both themes. A default color palette of eight colors is provided; custom colors can be set per participant.

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
| Workspace / Project / Session hierarchy | ✓ | | See Section 14 |
| Built-in scenarios (vc-debate, policy, code-review) | ✓ | | |
| Scenario inheritance + per-session overrides | ✓ | | |
| Project browser home screen | ✓ | | |
| Session list + new session wizard | ✓ | | |
| User-defined custom scenarios | ✓ | | |
| Electron desktop app (Windows/macOS/Linux) | ✓ | | See Section 13.2 |
| PWA manifest + responsive mobile layout | ✓ | | See Section 13.1 |
| Stance arc visualization | spec | ✓ impl | |
| Position map (force graph) | | ✓ | |
| Cross-entry chart comparison | | ✓ | |
| Cross-session search within a project | | ✓ | |
| Session export (PDF, shareable HTML) | | ✓ | |
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
- Maintaining three codebases (desktop, iOS, Android) for a small source-available project is not viable.
- App Store review cycles, sandboxing, and 30% cut conflict with the source-available, zero-cost model.
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

## 14. Workspace / Project / Session Model

### 14.1 Three-Level Hierarchy

Agentorum organizes user data in three levels:

| Level | Concept | Analogy |
|---|---|---|
| **Workspace** | Root folder on disk. One per user. | Documents folder |
| **Project** | A collection of related sessions. | Case file / portfolio |
| **Session** | One focused debate on one specific topic. | Meeting / hearing |

Each session is independent, append-only, and git-friendly. A project is a folder; a workspace is a folder of project folders. No database, no proprietary format.

### 14.2 Scenarios

A **scenario** is a reusable template that defines:
- The participant roster (IDs, labels, colors, stances, system prompts)
- The default automation rules
- The default `rules.txt` content
- Optional domain metadata (name, description, icon)

Scenarios are stored as `*.scenario.json` files. Built-in scenarios ship with the app (in `scenarios/` at the repo root). User-defined scenarios live in `~/.agentorum/scenarios/` and are addable through the GUI.

**Built-in scenarios (v1):**

| File | Description |
|---|---|
| `vc-debate.scenario.json` | VC investment panel: BULL-VC, BEAR-VC, DUE-DIL, SYNTH, PARTNER |
| `policy-mediation.scenario.json` | Policy stakeholder panel: ECON, CIVIL, INFRA, SYNTH, ANALYST |
| `code-review.scenario.json` | Coding agent review: ARCHITECT, CRITIC, QA, SYNTH, DEV |

### 14.3 Inheritance and Overrides (decided)

Configuration flows from scenario → project → session. Each level can override any field from the level above.

```
scenario.json          (template defaults)
    ↓ merged with
project.json           (project-level overrides, e.g. default LLM backend)
    ↓ merged with
session/session.json   (session-level overrides, e.g. custom system prompt for one participant)
    ↓ resolved to
session/agentorum.config.json   (fully merged config, written at session creation)
```

**Rules:**
- Any field present in `session.json` overrides the same field in `project.json` and the scenario.
- Any field present in `project.json` overrides the same field in the scenario.
- Fields absent at a lower level are inherited from the level above verbatim.
- `agentorum.config.json` is the resolved merge and is what the server reads. It is regenerated whenever overrides change.
- The scenario reference is stored as a string ID (e.g., `"vc-debate"`), not a file copy. Updating a scenario does not retroactively change existing sessions (sessions are pinned to the resolved config at creation time).

### 14.4 Data Files

**`workspace.json`**
```json
{
  "name": "My Agentorum Workspace",
  "created": "2026-03-19T00:00:00Z",
  "defaultProjectsDir": "~/.agentorum/projects"
}
```

**`project.json`**
```json
{
  "id": "vc-portfolio-q1-2026",
  "name": "VC Portfolio Q1 2026",
  "description": "Series A evaluations for Q1 pipeline.",
  "defaultScenario": "vc-debate",
  "overrides": {
    "participants": [
      { "id": "BULL-VC", "backend": "openai" }
    ]
  },
  "created": "2026-03-19T00:00:00Z"
}
```

**`session.json`**
```json
{
  "id": "techco-series-a",
  "name": "TechCo Series A — March 19",
  "scenario": "vc-debate",
  "created": "2026-03-19T14:00:00Z",
  "lastActive": "2026-03-19T15:42:00Z",
  "entryCount": 23,
  "overrides": {
    "participants": [
      {
        "id": "BEAR-VC",
        "systemPrompt": "Be especially critical of enterprise GTM assumptions."
      }
    ]
  }
}
```

### 14.5 GUI: Project Browser (Home Screen)

The home screen replaces the current "open chatlog" flow. It shows:

- **Workspace name** and settings gear
- **Project cards** — name, description, session count, last active date, default scenario badge
- **"New project" button** — prompts for name, description, default scenario
- **Search/filter bar** — filter projects by name or scenario type

Clicking a project opens the **Session list**:

- Sessions listed as rows: name, scenario badge, entry count, last active, one-line summary (from most recent SYNTH entry)
- **"New session" button** — opens the New Session wizard
- Sessions are sorted by last active date by default

### 14.6 GUI: New Session Wizard

Three steps:

1. **Pick a scenario** — grid of scenario cards (built-in + user-defined); each card shows name, participant roster preview, and description. "Start blank" option available.
2. **Name the session** — text field for session name; optional description.
3. **Customise (optional)** — expandable panel showing inherited participant config; any field can be overridden here. Changes are saved to `session.json` overrides only — the scenario is not modified.

One click on "Start" resolves the config, writes the session folder, and opens the Session view.

### 14.7 v1 Scope for This Feature

| Feature | v1 | v2+ |
|---|---|---|
| Workspace root folder + `workspace.json` | ✓ | |
| Project folder + `project.json` | ✓ | |
| Session folder + `session.json` + resolved config | ✓ | |
| Built-in scenarios (vc-debate, policy, code-review) | ✓ | |
| Scenario inheritance + override merge | ✓ | |
| Project browser home screen | ✓ | |
| Session list view with last-active + entry count | ✓ | |
| New session wizard (pick scenario, name, optional overrides) | ✓ | |
| User-defined custom scenarios (GUI editor) | ✓ | |
| Cross-session search within a project | | ✓ |
| Cross-project dashboard / activity feed | | ✓ |
| Session comparison (two sessions side by side) | | ✓ |
| Session export (PDF, shareable HTML) | | ✓ |

---

## 15. Open Questions

**Repo name:** Decided — `agentorum`, under the `khub-ai` GitHub organisation. Full URL: `https://github.com/khub-ai/agentorum`.

**NPM scope:** `@agentorum/server`, `@agentorum/watcher`, `@agentorum/client`, `@agentorum/desktop`. Decided — use the `@agentorum` scope for clean separation from the khub-ai org name.

**Chatlog migration:** When the format evolves (e.g., adding new reserved metadata fields), existing chatlogs must remain parseable. The parser must be lenient: unknown metadata fields are preserved verbatim, not stripped. This must be a hard constraint from v1.

**Agent response length:** Long agent responses degrade the timeline view. Should the GUI truncate card previews aggressively? Should there be a recommended max-length guideline in `rules.txt`? Open.

**Data entry versioning:** If `DUE-DIL` posts an updated revenue projection, does it replace the prior data entry in the Spreadsheet view, or appear as a separate entry? Current answer: separate entry (append-only), displayed in order. "Latest version" tracking is v2.

**SYNTH trigger strategy:** Auto-trigger every N entries works but may be wasteful. Smarter trigger (e.g., when stance imbalance exceeds a threshold, or when no rebuttal appears within K turns) is v2. v1 uses every_n_entries with configurable N.

---

## 17. Multimodal Support

Agentorum is designed to handle multimodal content — images, video, and other binary media — alongside text. This section records the design decisions and implementation layers.

### Chatlog format

The chatlog format is already multimodal-friendly. Entry bodies are Markdown, which natively supports image references:

```
![System architecture diagram](./media/arch-diagram.png)
```

Local media files are stored in a `media/` subfolder within the session directory. The server serves them at `/api/media/:filename`. This keeps the chatlog as human-readable plain text — binary data is never embedded in the file.

For video, a custom syntax avoids the ambiguity of Markdown's `![]()` image syntax:

```
@[video](./media/demo.mp4)
```

The client-side marked renderer converts this to a `<video controls>` element. This syntax is intentionally distinct from the `@key: value` metadata lines used at the top of entries (video references appear in the body, not the header block).

### Media serving

`GET /api/media/:filename` — serves files from `sessions/<id>/media/`. Path traversal (`..`) is stripped. Only files within the session's own media folder are accessible.

`POST /api/media/upload` — accepts `{ filename, data }` where `data` is a base64-encoded data URL (as produced by `FileReader.readAsDataURL()`). Decodes and writes to the media folder. Returns `{ ok, filename, url }`.

### Compose area

The compose bar has a 📎 attachment button. On file selection:
1. File is read as base64 in the browser (no size limit enforced in v1 — document a reasonable guideline, e.g. < 20 MB).
2. Uploaded via `POST /api/media/upload`.
3. A Markdown reference (`![name](url)` for images, `@[video](url)` for video, `[name](url)` for PDF) is inserted at the cursor position in the textarea.
4. A transient badge confirms the upload succeeded or reports failure.

### Agent-side multimodal analysis

This is the hard part. The current watcher builds a text-only prompt and pipes it to `claude --print` / `codex --full-auto` via stdin. These CLIs do not accept binary input. **Agent-side image or video analysis requires the `APIBackend`** (see Section 16) — direct HTTP calls to the Anthropic / OpenAI / Google APIs, which accept base64-encoded images in the messages array.

The watcher would need to:
1. Parse image references from the chatlog (`./media/*.{png,jpg,gif,webp}`)
2. Read and base64-encode each referenced file
3. Include them as image blocks in the LLM API messages array alongside the text prompt

Until `APIBackend` is implemented, agents receive image references as text (the Markdown syntax) but cannot process the image content itself.

### Video analysis

| Backend | Native video input | Frame extraction needed |
|---|---|---|
| Gemini (Google AI API) | Yes | No |
| Claude (Anthropic API) | No | Yes — extract frames via ffmpeg or js |
| GPT-4o (OpenAI API) | No | Yes |

Gemini is the simplest path for v1 video analysis. Frame extraction (for Claude/GPT-4o) is a v2+ item due to the ffmpeg dependency.

### Implementation status

| Feature | Status |
|---|---|
| External image URLs in entries | ✅ Works (marked.js renders `![]()`) |
| Local media file serving (`/api/media/`) | ✅ Implemented |
| File upload via compose bar | ✅ Implemented |
| Video playback in UI (`@[video]()` syntax) | ✅ Implemented |
| Agent-side image analysis | ⏳ Blocked on APIBackend (v2) |
| Agent-side video analysis (Gemini native) | ⏳ Blocked on APIBackend (v2) |
| Agent-side video analysis (frame extraction) | 🗓 v2+ |

---

## 16. Hosted Service Architecture (future)

A turn-key hosted service ("Agentorum Cloud") is a plausible v2+ direction for users who prefer convenience over control. This section records the forward-compatibility analysis and key architectural decisions.

### Forward-compatibility assessment

The current design is largely forward-compatible at the API and data model levels. The following do **not** need to change:

- REST API routes — add auth middleware, nothing else
- WebSocket event types (`init`, `entries_added`, `agent_status`, etc.)
- Entry format and chatlog parsing
- Participant / scenario / bundle model
- The UI (add login screen; core debate view unchanged)
- The workspace/project/session hierarchy — maps directly to a database schema

### Three areas requiring re-architecture

**1. File system → database**

`WorkspaceManager` is the correct abstraction point. Migration path: define a `WorkspaceBackend` interface with two implementations — `FileSystemBackend` (local/self-hosted) and `CloudBackend` (hosted service, backed by PostgreSQL + object storage). All server and UI code already goes through `WorkspaceManager`; no routes need changes.

| Local | Cloud equivalent |
|---|---|
| `chatlog.md` | Append-only rows in PostgreSQL |
| `session.json`, `project.json` | Database records |
| `rules-PARTICIPANT.txt` | Object storage (S3/R2) |
| `~/.agentorum/` workspace | Per-user namespace in multi-tenant DB |

**Recommended action now:** define a `WorkspaceBackend` interface before the file-based implementation grows more complex. This is the single highest-value forward-compat investment.

**2. Local CLI agents → direct LLM API calls**

`invokeAgent()` and `triggerAgent()` currently spawn `claude --print` / `codex --full-auto` as child processes. A hosted service must call the Anthropic and OpenAI APIs directly over HTTP. Define an `AgentBackend` interface with `CLIBackend` and `APIBackend` implementations. The change is fully contained in those two functions.

The **interactive agent mode** (user runs CLI locally, pastes init command) is a local-only feature — it does not apply in the hosted service. All hosted agents are automated API calls, which simplifies the architecture.

**Bring Your Own Key (BYOK)** is the correct model for v1 hosted: users provide their own Anthropic/OpenAI API keys, stored encrypted server-side (AWS Secrets Manager or equivalent). The service has zero LLM cost exposure.

**3. Multi-tenancy and authentication**

Currently assumes a single trusted local user. Hosted service requires:
- User accounts: signup, login, password reset, OAuth (Google/GitHub via Auth.js or Clerk)
- JWT or signed session cookies on every API request
- Namespace isolation: users cannot access each other's sessions
- Rate limiting per user
- The current per-session token is adequate locally; replace with standard JWT in cloud

This is the most pervasive change — touches every API route — but is entirely additive.

### Additional infrastructure concerns

**WebSocket scaling:** one process currently serves one workspace. Multi-user hosted deployment needs sticky routing (NGINX upstream hash) or a pub/sub layer (Redis Pub/Sub) so horizontal server scaling works without dropping WebSocket connections. Event contracts unchanged.

**Data privacy and compliance:** chatlogs will contain sensitive material (investment deliberations, medical discussions, legal matters). Design requirements before launch: encryption at rest and in transit, data residency options (EU hosting for GDPR), right-to-deletion, audit log of data access. The local-first model sidesteps all of this by default — users own their own data entirely.

### Billing and payments

**Use a Merchant of Record (MoR) platform, not a raw payment processor.**

The MoR (LemonSqueezy for early stage; Paddle once B2B volume grows) acts as the legal seller. It handles global VAT/GST/sales tax collection and remittance, EU consumer refund law compliance, and PCI DSS. You receive net revenue. The ~2% premium over direct Stripe is far cheaper than accountants and tax registrations across 50+ jurisdictions.

**Avoid:** absorbing LLM costs (cost spike exposure until usage is predictable), crypto payments (regulatory uncertainty, complex accounting), custom subscription infrastructure (use the MoR's built-in dunning, proration, and invoicing).

**Recommended pricing model (BYOK):**

| Tier | Price | Limits |
|---|---|---|
| Free | $0 | 3 sessions/month, 5 participants max |
| Pro | $19/month (or $15/month annual) | Unlimited sessions, all scenarios |
| Team | $49/month | Pro + shared workspace, up to 5 users |

Usage-based billing (per token, per session) adds metering complexity; defer until stable volume data exists.

**Payment method coverage via LemonSqueezy/Paddle:** Visa/MC/Amex globally, Apple Pay, Google Pay, PayPal, SEPA (EU), ACH (US). Covers the overwhelming majority of customers.

### Recommended sequence

1. Extract `WorkspaceBackend` interface from `WorkspaceManager` — do this before v2 work begins.
2. Extract `AgentBackend` interface from `invokeAgent()` / `triggerAgent()`.
3. Add auth middleware layer (additive, no route changes).
4. Add database backend implementation.
5. Add LLM API backend implementation.
6. Wire up LemonSqueezy billing and API key storage.
7. WebSocket scaling (only needed when concurrent user count justifies it).

---

## 18. Agent Rating System

### 18.1 Purpose

A debate is only as useful as the quality of its participants. As sessions grow longer and the same agents make repeated contributions, users and moderators need a lightweight, structured way to signal which contributions were valuable and which were not.

The agent rating system provides a **participant-level reputation score** computed entirely from typed rating events written directly into the chatlog. Scores are visible in the GUI without requiring any external service.

A secondary benefit: the rating log is part of the same append-only chatlog as the debate itself, so the full history of which contributions were rated (and why) is auditable and exportable alongside the debate transcript.

### 18.2 Rating Entry Format

A rating is a regular chatlog entry with additional metadata fields in the frontmatter:

```markdown
### 2026-03-19 14:22:00 - HUMAN

@type: rating
@target: BULL-VC
@event: catch
@score: 2
@entryRef: <sha256-of-rated-entry>

The TAM estimate was correctly challenged — the $4B figure double-counts the SMB segment.
```

Fields:

| Field | Required | Description |
|---|---|---|
| `@type: rating` | Yes | Identifies this entry as a rating event |
| `@target` | Yes | Participant ID being rated |
| `@event` | Yes | Named event type (see §18.3) |
| `@score` | No | Numeric point value; defaults to the event's canonical score if omitted |
| `@entryRef` | No | ID of the specific entry being rated; links pips to that card in the GUI |

Ratings may be submitted by any participant (human or agent). A Moderator agent can be configured to submit ratings automatically. When posted via the GUI rate modal, the rater is the participant selected in the "Rate as" dropdown.

### 18.3 Event Types and Point Values

| Event | Points | Meaning |
|---|---|---|
| `catch` | +2 | Correctly identified an error or flaw in another agent's argument |
| `insight` | +2 | Provided a novel, valuable perspective or insight |
| `confirm` | +1 | Corroborated a claim with supporting evidence |
| `error` | −2 | Made a factual error or logical mistake |
| `omission` | −1 | Failed to address a key relevant point |
| `retract` | −1 | Withdrew a previous claim without adequate justification |
| `deflect` | −1 | Avoided a direct question or challenge |

Point values are intentionally asymmetric: serious errors (−2) cost twice what a corroboration gains (+1), reflecting the higher cost of misinformation in a deliberation context.

### 18.4 Score Computation

`computeScores(entries)` on the server side:

1. Scans all entries for `@type: rating`
2. Groups by `@target` participant
3. Accumulates `@score` values (or default for the named event)
4. Returns `{ [participantId]: { total, events[] } }` where each event record includes: ratingEntryId, rater, event, score, entryRef, ts, rationale

Scores are computed fresh on each chatlog load and re-broadcast via `scores_updated` WebSocket message whenever a new rating entry arrives. There is no persistent score state — the chatlog is the source of truth.

### 18.5 GUI Components

**Score badge on agent card** — shown in the right-panel agent card next to the participant's name:
- Green background with `+N` for positive total scores
- Red background with `−N` for negative totals
- Muted `±0` for zero (only shown if at least one rating event exists)
- Hidden if the participant has no rating events yet

**Rating pips on entry cards** — small color-coded chips in the entry header showing `+2 catch` or `−1 omission` for each rating that references that entry via `@entryRef`. Positive events are green; negative are red.

**Rate button** — a `★` button appears in each entry header on hover (hidden for `@type: rating` entries themselves, to prevent recursive meta-ratings). Clicking opens the rate modal.

**Rate entry modal** — a full-screen modal (z-index 510, above the init modal at 500) with:
1. Entry reference card showing rated entry author, timestamp, and body preview
2. "Rate as" dropdown pre-selected to the first human participant
3. Radio group of all seven event types with name, point value, and one-line description
4. Optional rationale textarea
5. Submit (POST to `/api/entries` with metadata) and Cancel buttons

### 18.6 API

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/scores` | Returns computed scores for all participants |
| `GET` | `/api/scores/events` | Returns the canonical event map `{ eventName: points }` |
| `POST` | `/api/entries` | Accepts `{ author, body, meta }` — `meta` fields are written as `@key: value` frontmatter lines |

The `POST /api/entries` endpoint already supports arbitrary `meta` objects, so no new routes are required to submit a rating — the same endpoint used for regular entries handles it.

### 18.7 Moderator Agent Pattern

A dedicated `MODERATOR` participant can be added to any session to submit ratings automatically. Its system prompt instructs it to watch for notable events and post `@type: rating` entries referencing the original entry. Because ratings use the standard chatlog format, the moderator can be an automated agent, an interactive agent, or the human user — the system is indifferent.

### 18.8 Future Enhancements (v2+)

- **Rating history panel** — a dedicated sidebar view showing the full rating timeline for each participant, sortable by event type or time
- **Session-level leaderboard** — a ranked view of all participants by cumulative score at the end of a session
- **Moderator-generated summary** — auto-generated end-of-session summary calling out the highest-rated contributions and flagging flagged errors
- **Cross-session reputation** — aggregate scores across all sessions in a project, to track which participants improve or degrade over time with repeated use

---

## 19. Licensing and Contribution Policy

### 19.1 Project License

Agentorum is released under the **PolyForm Noncommercial License 1.0.0** (see `LICENSE` in the repository root). The full text governs all use; the summary below is for quick reference only.

**Permitted without restriction:**
- Personal use
- Internal business use (any company, any size) where the software is not offered to external customers or users
- Academic and research use
- Government use
- Evaluation and testing, including commercial evaluation

**Requires a separate commercial license:**
- Offering Agentorum as a hosted service to paying customers (SaaS)
- Bundling Agentorum in a product sold to third parties
- Any use where external parties are charged for access to Agentorum-powered functionality

**Key property:** PolyForm Noncommercial is *source-available*, not OSI-certified open-source. This distinction matters for compliance declarations in corporate environments. The source code is fully readable and modifiable; the restriction is on commercial *distribution and monetisation*, not on reading or running the code.

**Relicensing:** The project owner (`khub-ai`) explicitly retains the right to issue additional licenses (commercial, dual-license, etc.) in the future. All contributors grant this right via the CLA (§19.3).

**`package.json`** carries `"license": "PolyForm-Noncommercial-1.0.0"` as the SPDX identifier.

### 19.2 Why PolyForm Noncommercial

| Goal | How PolyForm NC satisfies it |
|---|---|
| Free for individuals and internal teams | Explicitly permitted; no seat limits, no registration |
| Prevents unauthorised commercial use | Commercial use clause requires a separate license |
| Allows future dual-licensing or commercialisation | Owner retains relicensing rights |
| Avoids GPL copyleft complications | PolyForm has no copyleft; modifications are private unless published |
| Recognisable, standardised text | PolyForm is a small set of professionally drafted licenses; courts and lawyers can read it |

### 19.3 Contributor License Agreement (CLA)

All external contributors must sign the **Individual CLA** (`CLA.md`) before their pull request can be merged. The CLA is a prerequisite, not a formality — it preserves the project's ability to issue commercial licenses in the future.

**What the CLA grants:**
- A broad copyright license covering the right to reproduce, modify, sublicense, and relicense the contribution under any terms the project owner chooses (including commercial licenses)
- A perpetual, irrevocable patent license covering any patents the contributor holds that are necessarily infringed by the contribution
- The contributor retains full ownership of their contribution

**What the CLA does not do:**
- It does not transfer ownership of the contribution to the project
- It does not prevent the contributor from using their own contribution in other projects

**How to sign:**
Post the exact phrase below as a comment on the pull request:

```
I have read the CLA Document and I hereby sign the CLA
```

The CLA Assistant bot (`contributor-assistant/github-action`) detects the comment, records the signature (GitHub username, timestamp, commit SHA, CLA version) in `signatures/cla-signatures.json` on the `cla-signatures` branch, and marks the PR check green.

**Re-signing:** Signatures are perpetual. A contributor who has already signed does not need to sign again for future PRs, unless the CLA document itself is updated to a new version. When the CLA version changes, all existing contributors who open a new PR will be prompted once to re-sign.

**Allowlist:** `bot*` accounts and `khub-ai` (the repository owner) are exempt and never prompted.

### 19.4 CLA Assistant Setup

The bot is configured in `.github/workflows/cla.yml`:

```yaml
- uses: contributor-assistant/github-action@v2.6.1
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    PERSONAL_ACCESS_TOKEN: ${{ secrets.CLA_PAT }}
  with:
    path-to-signatures: signatures/cla-signatures.json
    path-to-document: https://github.com/khub-ai/agentorum/blob/main/CLA.md
    branch: cla-signatures
    allowlist: bot*,khub-ai
```

**Required secret — `CLA_PAT`:**
- Type: GitHub classic Personal Access Token (not fine-grained)
- Scope: `repo` (full repository access)
- Expiration: **No expiration** (fine-grained PATs require mandatory expiration; classic PATs support perpetual tokens)
- Owner: The `khub-ai` account
- Set in: repository Settings → Secrets and variables → Actions → New repository secret

The `CLA_PAT` is needed because the bot writes to the `cla-signatures` branch (a cross-branch write), which `GITHUB_TOKEN` cannot do without elevated permissions.

### 19.5 Corporate CLA (Future)

The current CLA covers individual contributors only. When the project attracts contributions from organisations (corporations, universities), a **Corporate CLA (CCLA)** should be added alongside the individual CLA. The CCLA designates an authorised signatory at the organisation, and the organisation lists employees covered by the agreement. The CLA Assistant bot supports CCLA workflows; the setup is deferred until a corporate contribution materialises.

---

## 20. Workspace UI and Project Management

### 20.1 Home Page (Projects Grid)

The server root `/` serves `home.html` — a project management dashboard. Key elements:

- **Projects grid** — cards showing scenario badge, active indicator, session count, last-active time, and a ▶ Resume or + Session action button
- **▶ Resume button** — appears in the topbar when a session is currently active; navigates directly to `/session`
- **Active project card** — highlighted with a green left-border; click navigates directly to `/session` without an intermediate panel
- **Sessions panel** — slides in from the right when a non-active project card is clicked; lists sessions with Open/Resume buttons
- **🧹 Clean up inactive** — appears in the projects header when 2+ inactive projects exist; deletes all non-active projects in one confirmation

### 20.2 Session Continuity

`workspace.json` in `~/.agentorum/` stores `lastSession: { projectId, sessionId }`. On server startup without `--bundle`, the server reads this file and restores the last active session automatically — the user just runs `npm start`.

When a session is opened from the Projects page (`POST /api/sessions/:pid/:sid/open`), the server: stops any running agents, reloads the config, refreshes the session token, regenerates interactive agents' `rules-*.txt` files with the current token, restarts the chatlog watcher, and broadcasts the updated config to connected clients.

### 20.3 Summary Checkpoint

The 📋 button in the session topbar opens a modal editor for `summary.md` in the session directory. Agents' rules files instruct them to read `summary.md` first if it exists, before scanning the last 50 entries of the chatlog. This keeps context cost bounded as sessions grow.

API: `GET /api/summary` returns `{ content }`, `PUT /api/summary` with `{ content }` saves the file.

### 20.4 Session Export

The ⬇ button in the session topbar triggers `GET /api/export`, which returns a self-contained HTML file with all chatlog entries rendered in a dark-themed layout. The file is suitable for sharing with stakeholders not running Agentorum. Filename: `{project}-{session}.html`.

### 20.5 Scenario Editor

The Scenarios button in the home topbar opens a modal listing all built-in and user-created scenarios. User scenarios (stored in `~/.agentorum/scenarios/`) can be edited and deleted; built-in scenarios are read-only.

The New Scenario form collects:
- ID (slug), display name, icon (emoji), description
- Participants: ID, label, mode (human / interactive / watcher), system prompt (expandable per participant)
- Automation rules: "When [author] posts → notify [agent]" pairs
- Shared instructions visible to all agents

Saved via `POST /api/scenarios`; deleted via `DELETE /api/scenarios/:id`.

---

## Section 21: Navigation and Cross-Session Features

### 21.1 Session Switcher

A `<select>` dropdown (`#session-switcher`) in the session topbar lists all sessions in the current project. Selecting a different session calls `POST /api/sessions/:pid/:sid/open` and reloads the page, restoring the new session without visiting the Projects page.

The dropdown is hidden until the config arrives via the `init` WebSocket message, then populated from `GET /api/projects/:pid/sessions`.

### 21.2 Cross-Session Search

A search input in the sessions panel sidebar (`#sessions-search`) fires `GET /api/projects/:pid/search?q=…` (debounced 300 ms). Results are rendered as `<div class="search-result-item">` rows showing the session name, author, and a text snippet. Clicking a result opens that session.

### 21.3 PWA Support

`/manifest.json` provides app name, icons, start URL, and display mode (`standalone`). A `service-worker.js` at the server root caches the shell HTML, CSS, and JS on install; on fetch it uses a network-first strategy for API routes and cache-first for static assets. Users can install Agentorum to their device home screen on both Android and iOS.

### 21.4 Trigger Files

Every new chatlog entry causes the server to write `~/.agentorum/projects/:pid/sessions/:sid/trigger.json` with `{ entryId, author, timestamp }`. An interactive agent watching this file (e.g. with `chokidar`) can respond automatically when it detects a new trigger, bridging the gap between polling and a full push mechanism.

---

## Section 22: UX Refinements

### 22.1 Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| Ctrl/Cmd + Enter | Post the compose bar entry |
| Escape | Close the topmost open modal, or hide the compose bar |
| `/` | Focus the search bar (when compose bar is not open) |

Implemented as a `keydown` listener on `document`; Escape is consumed only when a modal or compose bar is visible.

### 22.2 Score Breakdown Modal

Clicking a participant's score badge (`<span class="score-badge">`) opens a modal showing:
- Participant name and total score
- A table of rating events in reverse chronological order: event type, score delta, rater, rationale, and timestamp

API: reads from the in-memory `scoreMap` already populated from `GET /api/scores`.

### 22.3 Entry Anchor Links

Each entry's timestamp (`<a class="entry-ts">`) is a real anchor link: clicking it calls `history.replaceState` to set `#entry-{id}` in the URL without a page reload. On initial page load, `scrollToAnchoredEntry()` parses `location.hash` and scrolls the matching entry into view, enabling shareable deep links.

### 22.4 Markdown Export

`GET /api/export?format=md` returns the session chatlog as a plain `.md` file. Each entry is rendered as:

```markdown
## {timestamp} — {author} ({label})

{body}

---
```

The 📝 button in the session topbar links to this endpoint with the `download` attribute. Filename: `{project}-{session}.md`.

### 22.5 Entry Copy Button

A 📋 icon button appears on hover in the right portion of each entry header. Clicking it calls `navigator.clipboard.writeText()` with the raw entry body text and briefly shows ✓ as a confirmation. Implemented as a delegated click handler on `#chatlog`.

---

## Section 23: Theme, Persistence, and Session Notes

### 23.1 Dark/Light Mode Toggle

A 🌙/☀️ button in the topbar of both the session page and the home page overrides the system `prefers-color-scheme`. The chosen theme is stored as `agentorum_theme` in `localStorage` and applied by setting `data-theme="dark"` or `data-theme="light"` on `<html>`. CSS selectors `html[data-theme="dark"]` and `html[data-theme="light"]` override the `@media` block.

### 23.2 Participant Entry Counts

Each agent card in the right-hand panel shows a small pill badge with the number of entries that participant has posted in the current session. The count is derived from `allEntries.filter(e => e.author === p.id).length` and updated every time `renderAgentCards()` is called.

### 23.3 Filter State Persistence

The author filter checkboxes in the left sidebar persist across page reloads. The set of hidden author IDs is saved to `localStorage` under `agentorum_filter_hidden` (JSON array) whenever a checkbox changes, and restored from that key on the `init` WebSocket message before the first `renderAll()`.

### 23.4 Session Notes / Description

Each session row in the sessions panel shows an editable notes area below the session name and metadata. Clicking the "Add notes…" placeholder (or existing note text) replaces it with a `<textarea>` that saves on blur or Enter via `PATCH /api/sessions/:pid/:sid/description` with `{ description }`. The description is stored in `session.json` and returned by `listSessions()`.

### 23.5 Session Archive

Sessions can be soft-archived (hidden from the default list without deletion) via a 🗂 button on each session row. Archiving sets `archived: true` in `session.json` via `PATCH /api/sessions/:pid/:sid/archive`. Archived sessions are excluded from `renderSessions()` by default; a "Show archived (N)" toggle at the bottom of the sessions panel reveals them. The active session cannot be archived.

---

## Section 24: Chatlog UX Enhancements

### 24.1 Jump to Latest Button

A floating "↓ Latest" pill (`#btn-jump-latest`) appears above the compose bar when the user has scrolled more than 300 px from the bottom of `#chatlog`. Clicking it smooth-scrolls to the most recent entry. The pill is hidden by default and shown/hidden via a `scroll` event listener on `#chatlog` (throttled to 100 ms).

When a new entry arrives via WebSocket and the user is near the bottom (within 300 px), the chatlog auto-scrolls to the new entry. If the user is scrolled further up, the pill pulses briefly to indicate new content.

### 24.2 Compose Textarea Auto-Resize

The `#compose-body` textarea grows with its content up to a maximum height of 200 px. On each `input` event, the textarea's height is reset to `auto`, then set to `Math.min(scrollHeight, 200)` px. This removes the need to scroll inside the textarea for most entries. When the content is cleared (after posting), the textarea returns to its default single-row height.

### 24.3 Entry Copy Button

A 📋 icon button appears on hover in each entry card header. Clicking it copies the entry body text to the clipboard via `navigator.clipboard.writeText()` and briefly flashes ✓ as confirmation. Implemented as a delegated click handler on `#chatlog` matching `.btn-copy-entry`.

### 24.4 Session Archive / Unarchive

Each session row in the sessions panel shows a 🗂 archive button. Clicking it sets `archived: true` in `session.json` via `PATCH /api/sessions/:pid/:sid/archive` with `{ archived: true }`. Archived sessions are excluded from the default `renderSessions()` list. A "Show archived (N)" toggle link at the bottom of the sessions panel reveals them with a muted visual style. Clicking the archive button on an archived session unarchives it (`{ archived: false }`). The active session cannot be archived.

---

### 25. Visualization Design Principles

All visualizations in Agentorum follow these design principles:

#### 25.1 Responsive-first layout

Every visualization must work well across the full range of screen sizes:

- **Phone (≤ 520px):** Charts collapse to a compact, scrollable strip. Interactive controls use touch-friendly 44×44px targets. Labels are abbreviated. Tooltips appear on tap-and-hold. The visualization occupies the full viewport width with no side panels.
- **Tablet (520–860px):** Charts render at full fidelity in a single-column layout. Legends and controls stack below the chart rather than beside it.
- **Desktop (> 860px):** Charts expand to fill available space. Legends and controls sit alongside or above the chart. Hover tooltips show rich detail. Multiple visualizations can be tiled when screen width allows.

Design rule: every chart must be usable (not just visible) on a phone. If a visualization requires hover to function, it must have a tap-and-hold equivalent.

#### 25.2 Maximum visual impact at every size

When more screen real estate is available, visualizations should expand to use it — not just center in a small box:

- Charts use `width: 100%` and compute height from the container, not fixed pixel values.
- Axes, labels, and tick counts scale with container width (more ticks on wider charts, fewer on narrow).
- On large displays (> 1400px), visualizations may use a split layout: chart on the left, detail/filter panel on the right.
- Color palettes are designed for both light and dark themes, using the existing CSS custom property system (`var(--text)`, `var(--bg-card)`, etc.).

#### 25.3 Data density and progressive disclosure

- Show the most important signal at a glance (the trend line, the hotspot, the outlier).
- Reveal detail on interaction (hover/tap for exact values, click to drill down).
- Provide controls to filter, zoom, or change time range — but default to a sensible "show everything" view.
- Never sacrifice clarity for completeness. If 50 participants make a chart unreadable, show the top 10 and offer an "expand" control.

#### 25.4 Consistent styling

All charts share a common visual language:
- Participant colors match their chatlog entry colors (drawn from the same `participantColor()` function).
- Chart backgrounds use `var(--bg-card)` with `var(--border)` for grid lines.
- Font sizes follow the same scale as the rest of the UI (11px for annotations, 13px for labels, 15px for titles).
- Animations are subtle and fast (200ms transitions, no gratuitous motion).

#### 25.5 Technology choices

- Primary charting library: **Chart.js** (lightweight, responsive, canvas-based, no build step required).
- Complex layouts (force-directed graphs, argument maps): **D3.js** loaded via CDN.
- All charts render client-side from data already available via the WebSocket connection or REST API. No server-side rendering.

---

## 26. Agent Coordination at Scale

When an ensemble grows beyond 3-4 agents, the question of "who should respond to this entry?" becomes critical. Fixed automation rules (e.g., "when HUMAN posts, trigger CLAUDE-DEV after 3s") do not scale — they cannot route based on content, and they trigger unnecessary responses. A single omniscient MODERATOR is fragile — it becomes the intelligence bottleneck and single point of failure, defeating the purpose of a distributed ensemble.

Agentorum uses a three-layer coordination architecture:

### 26.1 Layer 1: Self-Selection (primary mechanism)

Each agent's system prompt includes explicit respond-when / stay-silent-when criteria. When triggered, the agent reads recent entries and decides for itself whether it has something to contribute. This mirrors how real expert panels work — experts self-select into conversations they are qualified for.

Scenario configs support structured self-selection fields per participant:

```json
{
  "id": "SECURITY-ANALYST",
  "respondWhen": [
    "Authentication, authorization, access control",
    "Data handling, encryption, secrets management",
    "Input validation, injection vectors",
    "Dependency vulnerabilities"
  ],
  "staySilentWhen": [
    "UI/UX design, CSS, layout",
    "Performance optimization unrelated to security",
    "Business logic with no security implications"
  ]
}
```

These fields are injected into the agent's rules file as structured instructions. The agent retains autonomy — it may still choose to respond to an edge case not listed, or stay silent on a listed topic if it has nothing to add. The criteria are guidance, not hard routing.

When uncertain, agents should post a brief "flagging for review" note rather than a full response, letting the human or a synthesizer decide whether a deep response is needed.

### 26.2 Layer 2: Lightweight Router (cost optimization)

A fast classification step (Haiku-class model) runs on every new entry and produces routing tags — not a decision about who responds, but a filter for who even sees the entry.

Example:
- Entry: "The API endpoint accepts user input and passes it directly to a SQL query without parameterization"
- Router output: `{ tags: ["security", "backend", "database"] }`
- Trigger: SECURITY-ANALYST, BACKEND-DEV, DBA
- Skip: UI-DESIGNER, PRODUCT-MANAGER, DEVOPS

The router consults a role directory derived from the scenario config — each participant's `respondWhen` topics are matched against the entry content. This is a classification task, not a reasoning task, so a small fast model handles it reliably.

Implementation:
- Enabled by setting `"routing": "auto"` in the scenario config (default remains `"routing": "rules"` for backward compatibility with fixed automation rules).
- The router runs as server-side infrastructure — it is not a participant, does not appear in the chatlog, and does not consume a participant slot.
- Router results are logged to `routing-log.jsonl` in the session directory for auditability.
- The router call is debounced (waits 2 seconds after the last entry before routing) to batch rapid-fire entries.

### 26.3 Layer 3: Gap Detection (safety net)

A periodic background check (every 5 entries or 2 minutes, whichever comes first) scans for entries that received zero responses from any agent. When a gap is detected:

1. The system broadcasts to all agents: "The following entry received no response. If it falls within your area, please review: [entry summary]."
2. If still no response after one broadcast cycle, the system flags the entry for the human with a visual indicator in the chatlog UI.

Gap detection is not an LLM call — it is a simple temporal query: find entries in the last N that have no subsequent entry referencing or following them within the expected response window.

### 26.4 The MODERATOR Role (process control, not routing)

A MODERATOR participant is valuable but serves a different purpose than routing. The MODERATOR handles meta-cognition about the conversation:

- Summarizing areas of agreement and disagreement
- Redirecting the conversation when it drifts from the original question
- Escalating unresolved conflicts to the human
- Calling for synthesis when sufficient evidence has been presented
- Tracking which questions from the original prompt remain unaddressed

The MODERATOR does not need domain expertise in every field. It needs expertise in conversation dynamics: what has been covered, what remains open, where consensus exists, and where conflict persists.

The MODERATOR's system prompt should include:
- The list of all participants and their roles (from the scenario config)
- Instructions to track coverage of the original question
- Authority to call on specific agents by name when their area is relevant but they have not responded
- Instructions to post periodic status summaries (every N entries or when a major topic shift occurs)

### 26.5 System Prompt Library

Each agent role type requires a carefully designed system prompt that encodes domain expertise, response criteria, and interaction style. These prompts are stored as reusable templates in the scenario system.

Planned role types and their prompt characteristics:

| Role Type | Domain | Key Prompt Elements |
|---|---|---|
| SOLVER | General problem-solving | Independent analysis, commit to an answer, show full reasoning |
| CRITIC | Adversarial review | Find flaws, challenge assumptions, demand evidence, never agree without verification |
| SYNTHESIZER | Consensus-building | Read all positions, identify agreement/disagreement, produce unified summary |
| MODERATOR | Process control | Track coverage, manage turn-taking, escalate, redirect |
| DOMAIN-EXPERT | Configurable specialization | Deep knowledge in one area, respond-when/stay-silent-when criteria, cite evidence |
| RED-TEAM | Security/adversarial | Attack the proposal, find vulnerabilities, stress-test assumptions |
| FACT-CHECKER | Verification | Cross-reference claims, flag unsupported assertions, request sources |
| DEVIL'S-ADVOCATE | Contrarian | Argue the opposite position regardless of personal assessment, force steel-manning |
| JUDGE | Evaluation | Score arguments on defined criteria, declare winners, remain neutral |
| INDUCTOR | Knowledge extraction | Observe exchanges, extract general rules, persist learnings (requires Knowledge Fabric) |
| LEARNER | Adaptive participant | Start with minimal knowledge, improve through adversarial feedback, apply induced rules |
| ATTACKER | Adversarial pressure | Generate challenging counterexamples, probe edge cases, force deeper reasoning |

Each role type will have:
- A base system prompt template (Markdown, stored in `scenarios/prompts/`)
- Configurable parameters (e.g., domain specialization, aggressiveness level for CRITIC)
- Respond-when / stay-silent-when defaults appropriate for the role
- Example interaction patterns showing the expected behavior

The prompt library is designed to be composable — a scenario can mix role types freely, and a single agent can combine aspects of multiple roles (e.g., a CRITIC-JUDGE hybrid that both attacks arguments and scores them).

### 26.6 Coordination Flow Summary

The full coordination flow for a new entry in a large ensemble:

1. Entry arrives in the chatlog
2. If `routing: "auto"`: the lightweight router classifies the entry and produces tags (Haiku-class call, ~100ms)
3. Tagged agents are triggered (their CLI process or API call receives the new entry context)
4. Each triggered agent reads recent entries and self-selects: respond, flag for review, or stay silent
5. Responses are posted to the chatlog
6. If a MODERATOR is configured, it observes the exchange and may post process-control entries
7. Gap detection runs periodically and broadcasts missed entries
8. The human can override at any point — poke a specific agent, redirect the conversation, or post directly

This architecture scales from 2 agents (where the router is unnecessary and self-selection handles everything) to 20+ agents (where the router prevents cost explosion and gap detection ensures nothing is missed).

## 27. Rules File Refresh Signaling

### 27.1 The Problem

Interactive agents (Claude Code, Codex running in the user's terminal) read their rules file once when initialized via the "Read this file and confirm your role" paste command. If the rules file is regenerated later — for example when a session is reopened, a token refreshes, or shared rules are edited — the interactive agent continues operating from stale context with no awareness that the file has changed.

### 27.2 Solution: Chatlog-Based Signaling

The most reliable channel to reach an interactive agent is the one it is already watching: the chatlog. When `regenerateRulesFiles()` runs, the server automatically posts a SYSTEM entry to the chatlog addressing each affected agent by name:

```
### 2026-03-21 06:30:00 - SYSTEM

Rules files refreshed for this session.

@CLAUDE-DEV: Your rules file has been updated. Please re-read:
  C:\Users\kaihu\.agentorum\projects\...\rules-CLAUDE-DEV.txt

@CODEX-DEV: Your rules file has been updated. Please re-read:
  C:\Users\kaihu\.agentorum\projects\...\rules-CODEX-DEV.txt
```

Because each agent's rules file instructs it to read the last 50 entries of the chatlog before responding, the agent will see this SYSTEM entry on its next action and re-read the updated rules file.

### 27.3 Implementation Details

- `regenerateRulesFiles()` in `workspace.mjs` now returns `{ chatlogPath, updated: [{ id, rulesFilePath }] }` so the server knows which agents were affected.
- The server (`server.mjs`) posts the SYSTEM entry via `formatEntry('SYSTEM', body)` appended to the chatlog immediately after successful rules regeneration.
- The SYSTEM entry is a regular chatlog entry visible in the UI — the human can see that rules were refreshed and which agents were notified.
- If `regenerateRulesFiles()` fails (no config, no session file), no SYSTEM entry is posted and the failure is logged as a non-fatal warning.

### 27.4 When Rules Are Regenerated

Rules files are regenerated in the following situations:

| Trigger | Mechanism |
|---|---|
| Session opened from Projects page | `POST /api/sessions/:pid/:sid/open` calls `regenerateRulesFiles()` |
| Server startup with workspace restoration | Startup flow calls `regenerateRulesFiles()` for the restored session |
| Session token refresh | Token change triggers rules regen to update the `X-Agentorum-Token` header in each rules file |

### 27.5 Existing Fallback

The rules file itself includes a secondary signal: "If the server responds with `{"error":"invalid_token"}`, re-read this file to refresh your context." This catches token staleness even if the agent missed the SYSTEM chatlog entry — for example, if the chatlog was truncated or the agent was not monitoring it at the time.

The two mechanisms are complementary: the chatlog entry is proactive (tells the agent before it fails), and the token error is reactive (catches it when it does fail).

---

## 28. Agent Posting Methods

### 28.1 Two Posting Methods

Agentorum supports two methods for agents to post entries to the chatlog:

**Method 1: Direct file append (preferred for interactive agents)**

Interactive agents (Claude Code, Codex running in the user's terminal) append entries directly to the chatlog Markdown file. This avoids permission prompts — CLI tools like Claude Code and Codex display approval dialogs for every outbound HTTP request, creating unacceptable friction in a debate where agents may post dozens of entries.

The rules file instructs the agent to append using the exact entry format:

```
(blank line)
### YYYY-MM-DD HH:MM:SS - AGENT-ID

Response body here. Markdown supported.
```

The server's file watcher detects the new entry within its polling interval and handles all downstream processing: WebSocket broadcast to connected clients, automation rule evaluation, lightweight router classification, and trigger file generation. No functionality is lost compared to the API method.

**Method 2: HTTP API (preferred for automated and API-mode agents)**

Watcher agents (CLI subprocess) and API agents (direct LLM API calls) post via `POST /api/entries` with the `X-Agentorum-Token` header. These agents run server-side where permission prompts are not an issue, and the API provides immediate broadcast without waiting for the file watcher's polling interval.

### 28.2 Why Two Methods

| Concern | Direct file append | HTTP API |
|---|---|---|
| Permission prompts | None — file writes are pre-approved | Every curl/fetch triggers approval in interactive terminals |
| Latency to UI | Depends on watcher polling interval (~1-2s) | Immediate broadcast |
| Token validation | Not enforced — trusted by terminal context | Enforced via X-Agentorum-Token |
| Format correctness | Agent must follow exact format instructions | Server's formatEntry() guarantees correct format |
| Suitable for | Interactive agents (Claude Code, Codex) | Automated agents, API agents, external integrations |

### 28.3 Format Enforcement for Direct Appends

Interactive agents receive precise formatting instructions in their rules file:

1. A blank line before the `###` header (entry separator)
2. UTC timestamp in `YYYY-MM-DD HH:MM:SS` format
3. Author ID must exactly match the agent's configured ID
4. Blank line between header and body
5. No extra `###` headers within the response body
6. Append only — never overwrite or edit existing content

The chatlog parser (`parseEntries()`) is tolerant of minor whitespace variations but requires the `### TIMESTAMP - AUTHOR` pattern to identify entry boundaries. Malformed entries are silently skipped during parsing.

### 28.4 Fallback

The HTTP API remains available to interactive agents as a fallback. The rules file includes the curl command for agents that prefer or need it (e.g., when the agent cannot write to the file system). The token-error fallback ("if the server responds with invalid_token, re-read this file") applies only to the API method.
