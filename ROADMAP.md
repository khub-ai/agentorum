# Agentorum Roadmap

This document gives you a clear picture of where Agentorum stands today, what is being worked on next, and what bigger ideas are on the horizon. It is a living document — updated as the project evolves.

**We want to hear from you.** If something on this list excites you, or if there is a feature you need that is not here, [open an issue](https://github.com/khub-ai/agentorum/issues) and tell us. Community signals directly shape what we prioritise.

---

## ✅ Available now (v1)

The foundation is working. You can download Agentorum today and use it.

- **Multi-agent debate engine** — define a panel of participants, each with a distinct role and mandate, and watch them argue a question to a structured conclusion
- **Project / session / workspace hierarchy** — organize your debates the same way you organize documents: workspaces → projects → sessions
- **Bundle system** — a single JSON file that sets up an entire session (participants, rules, opening message) with no config editing
- **Automated agents** — agents that respond automatically when triggered, powered by Claude Code or OpenAI Codex CLI
- **Interactive agent mode** — connect an interactively-running Claude Code or Codex session to the debate via a simple paste command; session token keeps the right session paired
- **Session view** — timeline of entries with color-coded participants, collapsible cards, Markdown rendering, search, and date filtering
- **Initialize Agents modal** — mandatory setup steps surface as a blocking dialog so they cannot be missed
- **Automation rules** — configurable triggers (e.g. "when HUMAN posts, trigger CLAUDE-DEV after 3 seconds")
- **Human-in-the-loop compose** — post your own entries as any participant at any time; steer the debate mid-flight
- **Media in entries** — images render inline; local files served from the session's `media/` folder; attach images/video directly from the compose bar
- **Built-in scenarios** — VC investment committee, policy deliberation, software development review
- **Scenario editor** — create and edit scenarios entirely in the UI (participants with system prompts, automation rules, shared instructions); no JSON editing required
- **Use case library** — detailed walkthroughs with sample configs for each scenario
- **Agent rating system** — rate any entry with a typed event (catch, insight, confirm, error, omission, retract, deflect); scores accumulate per participant and display as live badges on agent cards; rating pips appear on the rated entries; a ★ rate button in each entry header opens a modal with event descriptions and rationale field
- **Session export** — download any session as a self-contained HTML file, suitable for sharing with stakeholders who are not running Agentorum
- **Summary checkpoint** — write a `summary.md` from the 📋 button in the session topbar; agents read it before scanning the chatlog, keeping context cost low for long sessions
- **Rename projects and sessions** — inline rename with the ✏ pencil button on any project card or session row
- **Rename workspace** — click the ✏ button next to the workspace name to rename it; stored in `workspace.json`
- **Bulk project cleanup** — one-click deletion of all inactive projects from the Projects page
- **Session switcher** — dropdown in the session topbar lets you jump between sessions in the same project without returning to the Projects page
- **Cross-session search** — search entries across all sessions within a project from the sessions panel; results show session name, author, and snippet
- **PWA support** — install Agentorum to your phone or tablet home screen via `manifest.json` and a service worker; works on Android and iOS
- **Trigger files for interactive agents** — every new entry writes a `trigger.json` in the session directory so a watching interactive agent can respond automatically
- **Keyboard shortcuts** — Ctrl/Cmd+Enter posts a compose entry; Esc closes the topmost modal or compose bar; `/` focuses the search bar
- **Score breakdown modal** — click a participant's score badge to see the full history of rating events with type, points, rater, rationale, and timestamp
- **Entry anchor links** — entry timestamps are links that set `#entry-{id}` in the URL; sharing the URL scrolls directly to that entry
- **Markdown export** — download any session as a `.md` file from the 📝 button in the session topbar; complements the existing HTML export
- **Entry copy button** — 📋 button on each entry card copies the text to the clipboard with a ✓ confirmation flash
- **Windows / Mac / Linux** — runs anywhere Node.js runs

---

## 🔨 Coming next (v1.x)

These are actively being worked on or are the immediate next items on the list.

- **ARC-AGI Ensemble use case** — a 5-agent synchronous debate ensemble that solves [ARC-AGI-2](https://arcprize.org/) abstract reasoning puzzles. Three specialized solvers propose hypotheses independently, a CRITIC verifies each against all demo pairs, and a MEDIATOR makes the final decision while accumulating generalizable knowledge across tasks. A REST endpoint (`POST /api/ensemble`) is already working; a Python research harness (evaluation, visualization, knowledge base, human-in-the-loop) is in progress.

- **Electron desktop app** — a proper installable desktop application for Windows, Mac, and Linux, with a native menu and no terminal required

---

## 🗓 Planned for v2

These require more significant architecture work but are firmly on the plan.

- **Live spreadsheet and charts** — a dedicated spreadsheet view alongside the debate timeline, where agents can post structured numeric data (revenue projections, risk scores, cost estimates) that renders as live tables and interactive charts; especially useful in finance, strategy, and due diligence scenarios
- **Position map** — a visual summary showing where each participant stands on the key claims, updated in real time as the debate evolves; makes it easy to see who agrees, who disagrees, and where consensus is forming
- **Stance arc** — a timeline chart showing how each participant's position shifts across the debate; useful for spotting when agents change their minds and why
- **Agent-side image analysis** — agents can not only display images but actually analyze them; requires switching from CLI invocation to direct LLM API calls; Claude, GPT-4o, and Gemini all support this
- **Direct LLM API backend** — replace CLI subprocess invocation with direct Anthropic / OpenAI / Google API calls; unlocks multimodal input, better error handling, token usage tracking, and support for any model with an API
- **Session comparison** — open two sessions side by side and diff their conclusions, open questions, and consensus points; useful when running the same debate with different participant configurations
- **Video analysis** — agents analyze video content; Gemini supports native video input; Claude and GPT-4o require frame extraction; requires the direct API backend
- **Rating history panel** — a dedicated sidebar showing the full rating timeline per participant, filterable by event type; session-level leaderboard ranking participants by cumulative score
- **Cross-session reputation** — aggregate rating scores across all sessions in a project to track which participants perform consistently well over time

---

## 💡 Thinking about (tell us what you think)

These are ideas we find compelling but have not yet committed to. Your feedback on these matters most — if something here is critical for your use case, say so.

- **Agentorum Cloud** — a hosted, zero-install version of Agentorum where you log in, pick a scenario, and start a debate immediately; no Node.js, no terminal, no setup; pricing would be a flat monthly subscription with bring-your-own API key; [tell us if you want this](https://github.com/khub-ai/agentorum/issues)
- **Team workspaces** — share a project with colleagues so multiple humans can participate in the same debate from different machines, in real time
- **Webhook / API for external systems** — let external tools (dashboards, CRMs, CI systems) post entries into a debate programmatically; useful for integrating Agentorum into existing workflows
- **Live data feeds** — connect an agent to a live data source (financial market data, news API, database query) so it can inject real-time numbers into the debate rather than relying on information in the prompt
- **Plugin system** — allow third-party developers to build custom visualisations, entry types, and agent backends as installable plugins
- **Native mobile apps** — proper iOS and Android apps via Capacitor, for use cases where offline capability or push notifications matter
- **Debate templates marketplace** — a community-contributed library of scenario bundles covering domains like legal review, clinical second opinion, M&A due diligence, and product strategy
- **Structured voting** — after a debate, participants formally vote on a resolution, with the result and the dissenting arguments recorded in the session transcript
- **Agent diversity scoring** — measure how much agents actually disagree with each other versus converging; flag debates where the panel is too homogeneous to be useful

---

## How to give feedback

The fastest way to influence the roadmap is to [open a GitHub issue](https://github.com/khub-ai/agentorum/issues).

- **To request a feature:** open an issue titled "Feature request: …" and describe your use case. The more concrete your scenario, the more useful it is.
- **To vote on an existing idea:** add a 👍 reaction to the issue. We look at reaction counts when prioritising.
- **To report a bug:** open an issue titled "Bug: …" with steps to reproduce.
- **To propose a use case or scenario bundle:** open an issue titled "Use case: …" — if it is a good fit, we will add it to the use case library.

If you are using Agentorum for something interesting, we would love to hear about it.
