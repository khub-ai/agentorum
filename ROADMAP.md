# Agentorum Roadmap

This document gives you a clear picture of where Agentorum stands today, what is being worked on next, and what bigger ideas are on the horizon. It is a living document — updated as the project evolves.

**We want to hear from you.** If something on this list excites you, or if there is a feature you need that is not here, [open an issue](https://github.com/khub-ai/agentorum/issues) and tell us. Community signals directly shape what we prioritise.

---

## ✅ Available now (v1)

The foundation is working. You can download Agentorum today and use it.

- **Multi-agent debate engine** — define a panel of participants, each with a distinct role and mandate, and watch them argue a question to a structured conclusion
- **Project / session / workspace hierarchy** — organise your debates the same way you organise documents: workspaces → projects → sessions
- **Bundle system** — a single JSON file that sets up an entire session (participants, rules, opening message) with no config editing
- **Automated agents** — agents that respond automatically when triggered, powered by Claude Code or OpenAI Codex CLI
- **Interactive agent mode** — connect an interactively-running Claude Code or Codex session to the debate via a simple paste command; session token keeps the right session paired
- **Session view** — timeline of entries with colour-coded participants, collapsible cards, Markdown rendering, search, and date filtering
- **Initialize Agents modal** — mandatory setup steps surface as a blocking dialog so they cannot be missed
- **Automation rules** — configurable triggers (e.g. "when HUMAN posts, trigger CLAUDE-DEV after 3 seconds")
- **Human-in-the-loop compose** — post your own entries as any participant at any time; steer the debate mid-flight
- **Media in entries** — images render inline; local files served from the session's `media/` folder; attach images/video directly from the compose bar
- **Built-in scenarios** — VC investment committee, policy deliberation, software development review
- **Use case library** — detailed walkthroughs with sample configs for each scenario
- **Windows / Mac / Linux** — runs anywhere Node.js runs

---

## 🔨 Coming next (v1.x)

These are actively being worked on or are the immediate next items on the list.

- **Session export** — download a session as a clean PDF or shareable standalone HTML file, suitable for sending to stakeholders who are not running Agentorum
- **Summary checkpoint** — SYNTH automatically writes a `summary.md` at configurable intervals, keeping context cost low for long sessions and giving agents a compressed history to work from
- **Custom scenario editor** — build and save your own participant panels directly in the UI, without editing JSON
- **Cross-session search** — search across all sessions within a project, not just the current one
- **PWA support** — install Agentorum to your phone or tablet home screen and use it as a full-screen app without a browser frame; works on Android and iOS
- **Mobile responsive layout** — the full debate view adapts to small screens with a collapsible bottom drawer for the agents panel
- **Trigger files for interactive agents** — when a new entry arrives, Agentorum writes a small trigger file so an interactive agent can be watching for it and respond without the developer prompting manually
- **Electron desktop app** — a proper installable desktop application for Windows, Mac, and Linux, with a native menu and no terminal required

---

## 🗓 Planned for v2

These require more significant architecture work but are firmly on the plan.

- **Live spreadsheet and charts** — a dedicated spreadsheet view alongside the debate timeline, where agents can post structured numeric data (revenue projections, risk scores, cost estimates) that renders as live tables and interactive charts; especially useful in finance, strategy, and due diligence scenarios
- **Position map** — a visual summary showing where each participant stands on the key claims, updated in real time as the debate evolves; makes it easy to see who agrees, who disagrees, and where consensus is forming
- **Stance arc** — a timeline chart showing how each participant's position shifts across the debate; useful for spotting when agents change their minds and why
- **Agent-side image analysis** — agents can not only display images but actually analyse them; requires switching from CLI invocation to direct LLM API calls; Claude, GPT-4o, and Gemini all support this
- **Direct LLM API backend** — replace CLI subprocess invocation with direct Anthropic / OpenAI / Google API calls; unlocks multimodal input, better error handling, token usage tracking, and support for any model with an API
- **Session comparison** — open two sessions side by side and diff their conclusions, open questions, and consensus points; useful when running the same debate with different participant configurations
- **Video analysis** — agents analyse video content; Gemini supports native video input; Claude and GPT-4o require frame extraction; requires the direct API backend

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
