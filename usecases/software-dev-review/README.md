# Multi-Agent Code Software Development

> **Many AI coding agents. One codebase. Greater productivity and quality.**
> When they agree, the finding is high-confidence. When they disagree, that is your flag to investigate.

---

## What this does

Most AI code review tools give you one model's opinion. This use case runs **Claude Code and OpenAI Codex side by side**, independently reviewing the same code at the same time — neither model sees the other's reasoning until both have responded.

The result is a review process that surfaces bugs, design problems, and edge cases that a single AI (or a single human reviewer) routinely misses — because independent review is structurally better than one review, every time.

You point both agent to your local code. Both agents read it and respond. They challenge each other. You steer the conversation. You get a prioritized list of issues you can act on immediately.

---

## Who this is for

- **Developers** who want a second opinion before merging a PR — without waiting for a colleague to be available
- **Tech leads** running architecture reviews who want structured, documented feedback rather than informal conversation
- **Engineering teams** building safety-critical or high-stakes software where catching a missed edge case is worth the extra step
- **Solo developers and freelancers** who rarely have a peer reviewer available but want the rigor of a real code review process
- **Teams adopting AI tooling** who want to validate that their AI-generated code actually holds up under scrutiny

You do not need to be an AI expert. You set up the environment and steer the agents to chat locally to each other, read the debate, and act on the findings. That is the full workflow.

---

## Why two agents beat one

A single AI reviewer has blind spots. It has training data biases, reasoning patterns it applies consistently, and a tendency to agree with the framing of the question it was asked.

A second AI with independent training — different model family, different corpus, different architecture — does not share those blind spots. Where it reaches the same conclusion, you have cross-validated evidence. Where it reaches a different conclusion, you have a signal worth investigating.

This is not a novelty. It is the same principle behind:

- **Pair review in code** — two engineers catching what one missed
- **Double-blind peer review** in research — reviewers who cannot see each other's notes
- **Red team / blue team** in security — one group attacks, one defends, neither defers to the other

Agentorum operationalizes that principle for code review with zero infrastructure overhead. Run it locally. No data leaves your machine. Works on any codebase.

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
- A structured, prioritized list of findings (critical / major / minor) ready to copy into your issue tracker
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

### 3. Choose your automation level

This use case supports two modes. Pick the one that fits your setup.

#### Option A: Interactive mode (default) — you relay between agents

In this mode, Claude Code and OpenAI Codex each run in their own terminal window on your machine. Agentorum does **not** control these terminals — you are the relay. The agents read and write to a shared chatlog file, but they do not watch it automatically. **You** tell each agent when to check for new entries and respond.

**Setup:**

1. Open **three windows**: the Agentorum UI in your browser, plus two terminal sessions (one for Claude Code, one for Codex).
2. In each terminal, paste the initialization command shown on the agent's card in the right-hand panel:

```
# Terminal 1 — Claude Code
Read this file and confirm your role: C:\Users\<you>\.agentorum\projects\...\rules-CLAUDE-DEV.txt

# Terminal 2 — OpenAI Codex
Read this file and confirm your role: C:\Users\<you>\.agentorum\projects\...\rules-CODEX-DEV.txt
```

3. Each agent reads its rules file, learns its role, the chatlog location, and how to post entries. It will confirm its role back to you. **The agent is now ready but will not act on its own.**

**The review loop (your moment-to-moment workflow):**

```
┌─────────────────────────────────────────────────────────────────┐
│  1. Post your code in the Agentorum UI (as HUMAN)              │
│  2. Switch to Terminal 1 → tell CLAUDE-DEV:                    │
│     "Check the chatlog and respond to the latest entry"        │
│  3. Wait for CLAUDE-DEV to post its review (appears in the UI) │
│  4. Switch to Terminal 2 → tell CODEX-DEV:                     │
│     "Check the chatlog and respond to the latest entries"      │
│  5. Wait for CODEX-DEV to post (appears in the UI)             │
│  6. Read both reviews. Post a follow-up as HUMAN if needed.    │
│  7. Repeat from step 2 until the review is complete.           │
└─────────────────────────────────────────────────────────────────┘
```

**Key points for interactive mode:**

- **You are the scheduler.** Agents do not poll the chatlog. When the UI shows an ⚡ badge on an agent's card, that is your cue to switch to that agent's terminal and prompt it.
- **Agents post by appending to the chatlog file.** They do not need network access or API calls — they write directly to `chatlog.md`. The Agentorum UI picks up new entries automatically via file watching.
- **You can address agents by name.** Post as HUMAN: *"CLAUDE-DEV, can you respond to CODEX-DEV's point about error handling?"* Then switch to Terminal 1 and tell it to check the chatlog.
- **Rules changes:** If you update session settings (add a participant, change automation rules), Agentorum regenerates the rules files and posts a SYSTEM message in the chatlog. Tell each agent: *"Re-read your rules file"* so it picks up the changes.
- **You can run one agent at a time.** If you only have Claude Code installed, skip Codex entirely — you still get a full single-agent review. Add the second agent later without reconfiguring anything.

#### Option B: API mode — fully automated

If you have API keys set (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`), you can switch both agents to `mode: "api"` in the session config. In this mode:

- The **server** calls the LLM APIs directly — no terminal sessions needed.
- Automation rules ("CODEX-DEV posts → trigger CLAUDE-DEV" and vice versa) fire automatically, creating a hands-free back-and-forth review.
- You post your code as HUMAN and both agents respond within seconds, then debate each other without further prompting.
- **You still steer.** Post as HUMAN at any time to redirect the conversation, ask for a fix, or end the review.

To switch to API mode, edit the session's participant config and change `mode: "interactive"` to `mode: "api"` for each agent, then set `apiProvider` and `apiModel` (e.g., `"anthropic"` / `"claude-sonnet-4-20250514"` for CLAUDE-DEV, `"openai"` / `"gpt-4o"` for CODEX-DEV).

### 4. Post your code

In the Agentorum UI, click ✏️ (or press **N**) to open the compose bar. Select **HUMAN** as your author. Paste the code you want reviewed. Add a one-line description of what you want checked:

> "Please review this for security vulnerabilities and edge cases in the input validation logic."

Press **Post** (or Ctrl+Enter).

- **Interactive mode:** switch to each agent's terminal and tell it to check the chatlog.
- **API mode:** both agents respond automatically within seconds.

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
| Agent never responds (interactive mode) | You haven't prompted the agent in its terminal | Switch to the agent's terminal and say "Check the chatlog and respond" |
| Agent says it doesn't know its role | Rules file not read on init | Paste the init command again: `Read this file and confirm your role: <path>` |
| Agent's entry doesn't appear in the UI | Entry format is wrong, or file not saved | Check that the agent appended to `chatlog.md` with the correct `### YYYY-MM-DD HH:MM:SS - AGENT-ID` header |
| ⚡ badge appears but you're not sure what to do | That's your cue to relay | Switch to that agent's terminal and prompt it to check the chatlog |
| `claude: command not found` | Claude Code CLI not installed | `npm install -g @anthropic-ai/claude-code` |
| `codex: command not found` | Codex CLI not installed | `npm install -g @openai/codex` |
| No response in API mode | API key missing or quota exceeded | Check `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` environment variables |
| Bundle file not found | Wrong working directory | Run from the root of the agentorum repo |
| Agent uses stale rules after config change | Rules file was regenerated but agent didn't re-read | Tell the agent: "Re-read your rules file" |

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
