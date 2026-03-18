# Agentorum

**Turn a group of AI agents into a structured debate team — and watch the argument unfold in real time.**

> *Working title: Agentorum. The final name is under discussion.*

---

## What is this?

Imagine you need to make a hard decision. You could ask one AI assistant and get one opinion. Or you could set up a panel — each member with a different role, a different bias, a different mandate — and let them argue it out in front of you.

That is what Agentorum does.

You define the participants. You set the topic. The agents debate. You watch it happen live, see who agrees with whom, track how the argument evolves, and step in whenever you want. When the dust settles, you have a structured, time-stamped record of every claim, rebuttal, and piece of evidence — not just a single answer, but the full shape of the reasoning behind it.

---

## Who is this for?

**Investors and analysts** who want to pressure-test an investment thesis before the partners meeting.

**Policy teams and advisors** who need to surface the strongest objections to a proposal before it goes to decision-makers.

**Product and strategy teams** who want to explore a market or a feature decision from multiple angles at once.

**Legal and compliance teams** running structured reviews where every position needs to be documented.

**Researchers and educators** running structured Socratic dialogues, ethics debates, or scenario analyses.

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

---

## Status

Early development. The core protocol and GUI foundation are being built now. The VC investment debate and policy deliberation scenarios are the primary design references — contributions and use-case suggestions welcome.

---

## Project structure

```
agentorum/
├── packages/
│   ├── server/       # Node.js backend: HTTP + WebSocket server, agent orchestration
│   ├── watcher/      # File watcher: monitors chatlog, triggers agents
│   └── client/       # Browser GUI: real-time dashboard
├── examples/
│   ├── vc-debate/        # Investment committee debate example
│   └── policy-mediation/ # Stakeholder policy deliberation example
└── specs/
    └── design-spec.md    # Full design specification
```

---

## License

MIT
