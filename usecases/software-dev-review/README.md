# Multi-Agent Code Review — Claude Code + OpenAI Codex

> **Two AI coding agents. One codebase. Zero shared reasoning.**
> When they agree, the finding is high-confidence. When they disagree, that is your flag to investigate.

---

## What this does

Most AI code review tools give you one model's opinion. This use case runs **Claude Code and OpenAI Codex side by side**, independently reviewing the same code at the same time — neither model sees the other's reasoning until both have responded.

The result is a review process that surfaces bugs, design problems, and edge cases that a single AI (or a single human reviewer) routinely misses — because independent review is structurally better than one review, every time.

You submit code. Both agents read it and respond. They challenge each other. You steer the conversation. You get a prioritised list of issues you can act on immediately.

---

## Who this is for

- **Developers** who want a second opinion before merging a PR — without waiting for a colleague to be available
- **Tech leads** running architecture reviews who want structured, documented feedback rather than informal conversation
- **Engineering teams** building safety-critical or high-stakes software where catching a missed edge case is worth the extra step
- **Solo developers and freelancers** who rarely have a peer reviewer available but want the rigour of a real code review process
- **Teams adopting AI tooling** who want to validate that their AI-generated code actually holds up under scrutiny

You do not need to be an AI expert. You paste code, read the debate, and act on the findings. That is the full workflow.

---

## Why two agents beat one

A single AI reviewer has blind spots. It has training data biases, reasoning patterns it applies consistently, and a tendency to agree with the framing of the question it was asked.

A second AI with independent training — different model family, different corpus, different architecture — does not share those blind spots. Where it reaches the same conclusion, you have cross-validated evidence. Where it reaches a different conclusion, you have a signal worth investigating.

This is not a novelty. It is the same principle behind:

- **Pair review in code** — two engineers catching what one missed
- **Double-blind peer review** in research — reviewers who cannot see each other's notes
- **Red team / blue team** in security — one group attacks, one defends, neither defers to the other

Agentorum operationalises that principle for code review with zero infrastructure overhead. Run it locally. No data leaves your machine. Works on any codebase.

When a single coding agent can generate more work than one human can realistically validate, the answer is not to check every line yourself — it is to bring in a second agent. One agent proposes; the other critiques. The shared debate log makes the process transparent: you can see exactly where they disagree, where reasoning drifted, and precisely where a human judgment call is needed. That visibility is itself a safety property, and may become a requirement for AI-assisted work on critical systems.

---

## The participants

| Agent | Role |
|---|---|
| **You (HUMAN)** | Post code and questions; steer the review |
| **CLAUDE-DEV** | Claude Code — bugs, security, spec mismatches, edge cases |
| **CODEX-DEV** | OpenAI Codex — same scope, fully independent view |

CLAUDE-DEV and CODEX-DEV are intentionally doing the same job. The redundancy is the product.

---

## What you get out

- Independent assessments from two AI agents that did not share reasoning
- Agreement signals — where both flag the same issue, treat it as high-confidence
- Disagreement flags — where they diverge, the gap itself is worth understanding
- A structured, prioritised list of findings (critical / major / minor) ready to copy into your issue tracker
- A complete Markdown chatlog you can commit to your repository as a permanent review record

---

## Prerequisites

1. **Node.js 18+** — [nodejs.org](https://nodejs.org). Verify: `node --version`
2. **Agentorum** — clone and install:
   ```
   git clone https://github.com/khub-ai/agentorum.git
   cd agentorum
   npm install
   ```
3. **Claude Code CLI** — install and authenticate:
   ```
   npm install -g @anthropic-ai/claude-code
   claude login
   ```
4. **OpenAI Codex CLI** — install and set your API key:
   ```
   npm install -g @openai/codex
   ```
   Then set your key:
   ```
   # Mac / Linux
   export OPENAI_API_KEY=your-key-here

   # Windows
   set OPENAI_API_KEY=your-key-here
   ```

> You can start with just Claude Code if you do not have a Codex API key yet — skip starting the CODEX-DEV agent and you still get a full single-agent review. The second agent can be added later without reconfiguring anything.

---

## Quickstart (5 minutes)

### 1. Start Agentorum

```
npm start
```

This starts the local server on port 3737 and opens `http://localhost:3737` in your browser.

### 2. Load the bundle

Click **Load Bundle** in the top bar, navigate to:

```
usecases/software-dev-review/software-dev-review.bundle.json
```

Agentorum creates the project and session and drops you into the session view. Alternatively, skip the UI entirely:

```
node packages/server/server.mjs --bundle usecases/software-dev-review/software-dev-review.bundle.json --open
```

### 3. Initialize the agents

Both agents are configured as **interactive** — they run in your own terminal sessions (Claude Code and OpenAI Codex), not as server-managed subprocesses.

**Option A: Interactive mode (default)**

Open two separate terminal windows. In each, paste the initialization command shown on the agent's card in the right panel:

```
# Terminal 1 — Claude Code
Read this file and confirm your role: C:\Users\<you>\.agentorum\projects\...\rules-CLAUDE-DEV.txt

# Terminal 2 — OpenAI Codex
Read this file and confirm your role: C:\Users\<you>\.agentorum\projects\...\rules-CODEX-DEV.txt
```

Each agent will read their rules file, confirm their role, and begin watching the chatlog. When the UI shows an ⚡ badge on an agent's card, prompt that agent in its terminal to check the chatlog and respond.

**Option B: Fully automated (API mode)**

If you have API keys set (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`), you can switch both agents to `mode: "api"` in the session config. The server will call the LLM APIs directly — no terminal sessions needed. The automation rules ("CODEX-DEV posts → trigger CLAUDE-DEV" and vice versa) will fire automatically, creating a hands-free back-and-forth review.

### 4. Post your code

At the bottom of the session view, select **HUMAN** as your author. Paste the code you want reviewed. Add a one-line description of what you want checked:

> "Please review this for security vulnerabilities and edge cases in the input validation logic."

Press **Post** (or Ctrl+Enter). In interactive mode, check each agent's terminal and prompt them to respond. In API mode, both agents will respond automatically within seconds.

---

## A real example

Here is what a review looks like in practice. The developer posted a JavaScript function with a subtle bug:

---

**🟡 HUMAN** — *Please review this for bugs and edge cases:*

```javascript
async function processItems(items, threshold) {
  const results = [];
  for (let i = 0; i <= items.length; i++) {
    const item = items[i];
    if (item.value > threshold) {
      const enriched = await fetchMetadata(item.id);
      results.push({ ...item, ...enriched });
    }
  }
  return results;
}
```

---

**🟠 CLAUDE-DEV** — *Off-by-one in the loop condition: `i <= items.length` should be `i < items.length`. On the final iteration, `items[i]` is `undefined`, and accessing `.value` throws a TypeError. Separately: if `fetchMetadata` rejects, the error propagates out of the function as an unhandled rejection — consider wrapping in try/catch if partial results are acceptable.*

---

**🔵 CODEX-DEV** — *Agreed on the off-by-one. I want to add a separate issue: `await` inside a `for` loop means all `fetchMetadata` calls run sequentially. For a non-trivial list, `Promise.all` would run them concurrently — but note that `Promise.all` fails fast, so if any call rejects you lose all results. That needs to be an explicit decision, not an accidental side effect of a performance refactor.*

---

Both agents caught the bug. CODEX-DEV surfaced a performance concern CLAUDE-DEV did not mention. CLAUDE-DEV flagged the error-handling gap that `Promise.all` would actually make worse. Together they gave the developer a more complete picture than either alone.

---

## How to steer the review

**Ask for a fix** — Reply as HUMAN: *"CLAUDE-DEV, can you show me a corrected version of that loop?"*

**Inject the spec** — Paste the requirement the function is supposed to implement. Agents can evaluate implementation against intent rather than guessing what "correct" means.

**Redirect a circular debate** — Post: *"Let's set aside the async discussion and focus on input validation now."*

**Focus on a section** — For large files, paste the most relevant 100–200 lines and describe the rest in prose. Agents focus better on bounded context.

**Export the review** — Use the ⬇ button in the topbar to download the full session as a self-contained HTML file. Or export as Markdown (📝) to commit alongside the code.

---

## Tips for best results

- **Include the spec alongside the code.** "Does this match the requirement?" is a richer question than "Is this code correct?"
- **Keep pastes under ~200 lines.** Break large reviews into sections — authentication one session, data layer the next.
- **When both agents agree, trust the finding.** Cross-validated findings across independent models are high-confidence.
- **When agents disagree, investigate.** The gap is often more informative than the agreement.
- **Commit the chatlog.** It is a plain Markdown file. Six months later you will want to know why a design decision was made.

---

## Troubleshooting

| Problem | Likely cause | Fix |
|---|---|---|
| Agent card shows "stopped" immediately | CLI not installed or not on PATH | Run `claude --version` or `codex --version` to confirm |
| No response after posting | Agent not started | Click **Start** on the agent card |
| `claude: command not found` | Claude Code CLI not installed | `npm install -g @anthropic-ai/claude-code` |
| `codex: command not found` | Codex CLI not installed | `npm install -g @openai/codex` |
| Response is empty | API key missing or quota exceeded | Check your API key environment variable |
| Bundle file not found | Wrong working directory | Run from the root of the agentorum repo |

---

## Extend this setup

This bundle is a starting point. From the **Scenarios** menu in Agentorum you can add participants to the same session:

- **ARCHITECT** — evaluates structure, separation of concerns, and design patterns (not bugs)
- **CRITIC** — specifically looks for what the other agents agreed on too fast or missed entirely
- **SYNTH** — produces a structured summary every N entries: findings by severity, agreements, and open questions

Adding these turns the two-agent review into a full review board. The two-agent version is the right starting point for most teams — add the others when you want to go deeper.

---

## Related

- [← All use cases](../README.md)
- [Agentorum home](../../README.md)
- [VC Investment Committee use case](../vc-investment-committee/) — multi-agent financial analysis
- [Policy Deliberation use case](../policy-deliberation/) — stakeholder debate on a regulation proposal
- [Full design specification](../../specs/design-spec.md)
