# Agentorum

**A source-available, no-code platform for structured multi-agent debate — with purpose-built visualization, live data charts, full audit trail, and human-in-the-loop control. Runs out of the box, no additional software or coding required. Just bring your LLM API key. Free for non-commercial use.**

→ **[See the full roadmap and tell us what to build next](ROADMAP.md)**

---

## How Agentorum is different

Every other multi-agent tool routes tasks through a pipeline. Agentorum runs a **debate**.

| | Agentorum | Task-automation agents (Agentforce, Operator, Devin) |
|---|---|---|
| Multi-agent deliberation | **Yes — core purpose** | No — task handoff only |
| Purpose-built debate GUI | **Yes** | No |
| Live data tables and charts | **Yes** | No |
| Human steers debate in real time | **Yes — first class** | Limited |
| Complete transcript with configurable analysis — know exactly how every conclusion was reached | **Yes** | Session logs only |
| Runs out of the box, no coding required | **Yes** | No |
| LLM-agnostic (Claude, GPT, Gemini, local) | **Yes** | Vendor-locked |
| Local data — you own everything generated | **Yes** | Cloud-stored |
| Domain-agnostic | **Yes** | Product- or CRM-specific |
| Source-available and free | **Yes** | No |

Agentorum is the only tool that combines structured deliberation, rich visualization, zero-coding setup, and source-available transparency in a single package aimed at non-technical users.

---

## Why use Agentorum?

A single AI gives you a single answer. That answer reflects one framing of your question, one set of assumptions, and one blind spot. For low-stakes questions, that is fine. For decisions that actually matter — where to invest, what policy to recommend, which strategy to pursue — a single answer is a liability.

Agentorum is built on a different premise: **the best way to stress-test an idea is to argue it out loud, from multiple directions, with someone who disagrees.**

Here is what you concretely gain:

**Higher-quality decisions.** Structured adversarial debate surfaces the objections that a single-viewpoint analysis misses. You hear the bull case and the bear case developed simultaneously, by participants that are each trying to win. That tension is the point.

**Faster due diligence.** What might take a team days of back-and-forth email and document review, Agentorum compresses into a structured session you can replay, search, and share. Every claim is on the record. Nothing falls through the cracks.

**A shareable audit trail.** You end every session with a complete, timestamped record of who said what, what was contested, what was conceded, and what questions remain open. That document is ready to share with colleagues, attach to a decision memo, or archive for compliance.

**Less groupthink.** When you brief a single AI assistant, it is subtly shaped by however you framed the question. Agentorum's role-based participants have independent mandates — the bear case participant is instructed to find every flaw, regardless of how the question was posed. That independence is built in.

**Structured data alongside argument.** Numbers don't belong buried in paragraphs. When a participant makes a claim about revenue, costs, or risk, they can post a live table and chart alongside the argument. You see the figures and the reasoning in the same place.

**Full control, always.** You are not a passive observer. You can steer the debate at any point — inject new information, challenge a participant, redirect the conversation, or call for a synthesis. Agentorum keeps the agents on-task while you stay in the chair.

**No lock-in, no cloud, no bill.** Your debate data lives in a plain-text file on your own machine. You can use any LLM you already have access to. Nothing is stored by us because there is no "us" in the middle — just self-hosted software you run yourself.

**A force multiplier for coding agents.** When a single coding agent can generate more work than one human can realistically validate, bring in a second agent to check it. Two agents reviewing the same code independently — Claude Code and OpenAI Codex, for example — surface issues that neither catches alone. Agreement is a high-confidence signal; disagreement is a flag worth investigating. → [See the Software Development Review use case](usecases/software-dev-review/README.md)

---

## What is this?

When you ask one AI assistant a hard question, you get one answer. One perspective. One blind spot.

Agentorum gives you a panel instead. You define a set of participants — each with a distinct role, a different mandate, a deliberate bias — and they work the problem together. A bull and a bear arguing an investment. An advocate and a skeptic pressure-testing a policy. A domain expert and a devil's advocate stress-testing a strategy.

The result is not a single response. It is a **structured record of the full argument**: every claim, every rebuttal, every concession, every open question — time-stamped, searchable, and shareable.

You stay in control throughout. You can steer the debate, inject new information, challenge a participant directly, or call for a synthesis at any point. Agentorum keeps the panel on-task and the record clean.

**What you get that you cannot get from a single AI response:**

- The strongest case *and* the strongest objection, developed simultaneously
- A live, auto-updating summary of where the argument stands at any moment
- A visual map of which participants agree, which are opposed, and which claims are still contested
- Structured data — financial projections, cost tables, survey figures — rendered as live charts, not buried in paragraphs
- A complete, auditable transcript you can share with colleagues or attach to a decision memo

---

## Who is this for?

**Investors and analysts** who want to pressure-test an investment thesis before the partners meeting.

**Policy teams and advisors** who need to surface the strongest objections to a proposal before it goes to decision-makers.

**Product and strategy teams** who want to explore a market or a feature decision from multiple angles at once.

**Legal and compliance teams** running structured reviews where every position needs to be documented.

**Researchers and educators** running structured Socratic dialogues, ethics debates, or scenario analyses.

**Software developers** running two coding agents side by side to cross-validate each other's findings before trusting the output. → [Software Development Review use case](usecases/software-dev-review/README.md)

**Risk and compliance officers** who need documented, auditable reasoning trails for AI-assisted decisions — not just the conclusion, but the full path to it.

**Executives and board members** who want a concise, structured briefing on a strategic question where key disagreements and trade-offs are surfaced rather than smoothed over.

**Medical and clinical teams** where treatment plans or diagnostic reasoning benefit from a structured second opinion, with full documentation for the record.

**Journalists and fact-checkers** running structured source challenges: one agent argues the claim is supported, another argues it isn't, a third checks primary sources.

**Consultants and advisory firms** who need to show clients not just a recommendation but the full deliberative process that produced it.

Essentially: anyone who benefits from structured disagreement, and who wants that disagreement to be fast, thorough, and auditable.

---

## A concrete example: the investment committee

You are a venture partner evaluating a Series A startup. Instead of writing a memo yourself, you spin up four participants:

| Participant | Role |
|---|---|
| `BULL-VC` | Argues for investment — finds the strongest case |
| `BEAR-VC` | Argues against — finds every risk and weakness |
| `DUE-DIL` | The analyst — asks hard factual questions, pulls up numbers |
| `SYNTH` | The synthesizer — periodically summarises where the argument stands |
| You (`PARTNER`) | The GP — you steer, probe, and ultimately decide |

You paste in the pitch deck. The debate begins. `BULL-VC` makes the bull case. `BEAR-VC` rebuts. `DUE-DIL` asks about the CAC figures. `BULL-VC` posts a revenue projection table. `BEAR-VC` challenges the TAM assumptions. `SYNTH` summarises after every five turns: *"Both sides agree the team is strong. The disagreement centres on whether the $4B TAM figure is defensible. Open question: is the enterprise segment accessible without a direct sales motion?"*

You watch all of this in a live dashboard. You see a chart of how the bull and bear positions have been trending. You see the revenue projections rendered as a live table and bar chart, not buried in a wall of text. You see the thread of the argument as a tree, not just a flat scroll of messages.

At the end, you have a document you can share with the full partnership — a complete record of the debate, not just the conclusion.

---

## Another example: policy deliberation

A policy analyst is assessing a proposed data-retention regulation. Three AI participants — an economic advisor, a civil-liberties advocate, and an infrastructure engineer — debate the trade-offs. A human facilitator steers the conversation.

The civil-liberties advocate raises GDPR parallels. The economic advisor posts compliance-cost estimates as a live spreadsheet. The infrastructure engineer explains what the retention window means in practice for database architecture. The facilitator asks all three to converge on a recommendation.

The output is not a single position paper. It is a structured map of where the parties agree, where they disagree, and why.

---

## What makes the GUI different

Most tools show you a chat log. Agentorum shows you a **debate**.

**Thread view** — see which arguments reply to which, not just what order they arrived in.

**Position map** — a live diagram showing which participants are aligned, which are opposed, and which claims are contested.

**Stance arc** — a timeline showing whether the bull case or the bear case has been gaining or losing ground over the course of the debate.

**Live data tables and charts** — any participant can post structured data (financial projections, survey results, cost estimates) and the dashboard renders it as an interactive table and chart, not a block of numbers in a paragraph.

**Debate summary panel** — a persistent sidebar that updates automatically, showing the current state of the argument: claims made, points conceded, open questions remaining.

**Full-text search and filtering** — search by participant, by topic, by date, or by entry type (claim, rebuttal, synthesis, data). Collapse what you don't need; expand what matters.

---

## How it works (the short version)

Under the hood, everything is stored in a single plain-text file — a shared log that every participant appends to. This means the debate is always a readable, version-controlled document, not locked in a proprietary database. The GUI is a browser-based dashboard that reads the log in real time and presents it visually.

You configure who the participants are, what they know, and what rules they follow. You can trigger agents manually or set up automation rules ("whenever the human posts, automatically trigger `DUE-DIL` after five seconds"). Agents are pluggable — you can connect any AI model or even a human colleague.

There is nothing to install beyond Node.js. There is no cloud service. Your debate data stays on your machine.

---

## Key features

- **Real-time collaborative dashboard** — multiple browser windows, live updates via WebSocket
- **Live spreadsheet and charts** — structured data entries render as interactive tables and bar/line/pie charts
- **Thread/tree view** — arguments visualised as a reply tree, not a flat list
- **Stance arc** — see how positions have been shifting over time
- **Position map** — spatial diagram of who agrees with whom
- **Debate summary panel** — auto-updating synthesis of the current argument state
- **Full search and filter** — by author, date, entry type, stance, topic
- **Automation rules** — define who triggers whom, and when
- **Pluggable agent backends** — connect Claude, GPT, Gemini, local models, or humans
- **Append-only log** — plain Markdown, human-readable, version-controllable
- **Localhost by default** — nothing leaves your machine
- **Source-available and free** — PolyForm Noncommercial license, no subscriptions, no usage fees, no vendor lock-in

---

## Status

Early development. The core protocol and GUI foundation are being built now. The VC investment debate and policy deliberation scenarios are the primary design references — contributions and use-case suggestions welcome.

---

## Project structure

```
agentorum/                        (repo)
├── packages/
│   ├── server/                   # Node.js backend: HTTP + WebSocket server, agent orchestration
│   ├── watcher/                  # File watcher: monitors chatlog, triggers agents
│   ├── client/                   # Browser GUI: project browser + session dashboard
│   └── desktop/                  # Electron shell: single-click desktop app
├── scenarios/                    # Built-in reusable debate templates
│   ├── vc-debate.scenario.json
│   ├── policy-mediation.scenario.json
│   └── code-review.scenario.json
├── examples/
│   ├── vc-debate/                # Runnable investment committee example
│   └── policy-mediation/         # Runnable stakeholder policy example
├── usecases/                     # Detailed use cases with sample configs and transcripts
└── specs/
    └── design-spec.md            # Full design specification

~/.agentorum/                     (user workspace, on your machine)
├── scenarios/                    # Your custom debate templates
└── projects/
    └── my-project/
        └── sessions/
            └── my-session/
                ├── chatlog.md    # The debate — plain text, yours forever
                └── ...
```

---

## Getting started

### Prerequisites

- [Node.js 18+](https://nodejs.org/) — the only required installation
- An API key for at least one LLM (Claude, OpenAI, or a local Ollama model)

### Run

```bash
git clone https://github.com/khub-ai/agentorum.git
cd agentorum
npm install
npm start
```

This opens the project browser at `http://localhost:3737`.

**First time:** create a project from the browser UI, pick a scenario, and start a session.

**Every subsequent restart:** just `npm start` again — Agentorum automatically resumes where you left off. No flags needed.

> **Windows users — if `npm start` gives a security error in PowerShell:**
>
> PowerShell may block npm because the script is not digitally signed. Use either of these instead:
>
> ```powershell
> # Option A — run directly with node (recommended, always works):
> node packages/server/server.mjs --open
>
> # Option B — unblock npm once and for all:
> Unblock-File "$(where.exe npm | Select-Object -First 1)"
> # then npm start will work normally going forward
> ```
>
> This is a Windows security policy quirk, not an Agentorum issue. The Electron desktop installer (coming soon) will not have this problem.

### Setting up a specific use case

Use case bundles set up a project and session in one step. Run the setup command once; after that, plain `npm start` resumes that session automatically.

```bash
# Software development review (Claude Code + OpenAI Codex)
npm run setup:software-dev
```

### Try a built-in example directly (legacy single-session mode)

```bash
# VC investment debate
node packages/server/server.mjs --config examples/vc-debate/agentorum.config.json --open

# Policy deliberation
node packages/server/server.mjs --config examples/policy-mediation/agentorum.config.json --open
```

---

## License

Agentorum is released under the **[PolyForm Noncommercial License 1.0.0](LICENSE)**.

**Free** for personal use, research, internal business use, government, education, and non-commercial projects — at any scale, with no strings attached.

**A separate commercial license is required** if you charge others for access to Agentorum, offer it as a hosted service, or bundle it into a paid product. To discuss commercial licensing, open an issue or contact us via GitHub.

> If you are evaluating Agentorum for commercial use, you may do so freely — the license explicitly permits commercial evaluation before any commitment.
