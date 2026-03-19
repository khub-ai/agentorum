# Software Development Review — Multi-Agent Code Review with Claude Code and OpenAI Codex

## What you will get

Run your code through a structured multi-agent debate and get the kind of review that a single AI tool — or even a single human reviewer — rarely delivers on its own. Five participants with distinct perspectives read your code, argue with each other, and produce a structured synthesis you can act on immediately.

Concrete outcomes:

- A full independent review of your code from two AI agents (Claude Code and OpenAI Codex) that do not share reasoning — so when they agree, the finding is high-confidence
- A structured list of issues grouped by severity (critical, major, minor), ready to copy into your bug tracker
- Architectural feedback that goes beyond correctness — design patterns, separation of concerns, scalability
- A devil's advocate pass that specifically targets findings the other agents converged on too quickly
- A final synthesis entry from SYNTH that serves as your official review record

---

## How it works

Five participants sit in the debate. You post code and questions; the agents respond, push back on each other, and build toward a synthesis. Each participant has a distinct job — they are not all doing the same thing with different names.

| Participant | Role | What they look for |
|---|---|---|
| **HUMAN (Developer)** | You | Posts code, specs, follow-up questions, and redirects |
| **CLAUDE-DEV** | Claude Code | Bugs, edge cases, spec mismatches, security issues |
| **CODEX-DEV** | OpenAI Codex | Same scope as CLAUDE-DEV — forms an independent view, does not defer to Claude |
| **ARCHITECT** | Design reviewer | Structure, separation of concerns, design patterns, scalability — not bug-hunting |
| **CRITIC** | Devil's advocate | Actively looks for what the other agents missed or agreed on too fast |
| **SYNTH** | Synthesizer | Every 5 entries: structured summary of issues, agreements, and open questions |

CLAUDE-DEV and CODEX-DEV are deliberately doing the same job with different models. That redundancy is the point — agreement between them is a signal, disagreement is a flag worth investigating.

SYNTH does not have an opinion of its own. It reads what everyone else said and produces the structured output. Treat its summaries as your actionable checkpoints.

---

## Prerequisites

1. **Node.js 18 or later** — download from [nodejs.org](https://nodejs.org). Verify: `node --version` should show v18 or higher.
2. **Agentorum** — clone and install:
   ```
   git clone https://github.com/khub-ai/agentorum.git && cd agentorum && npm install
   ```
3. **Claude Code CLI** — install and authenticate:
   ```
   npm install -g @anthropic-ai/claude-code
   claude login
   ```
   Verify: `claude --version`
4. **OpenAI Codex CLI** — install and set your API key:
   ```
   npm install -g @openai/codex
   ```
   Then set your key — on Mac/Linux:
   ```
   export OPENAI_API_KEY=your-key-here
   ```
   On Windows:
   ```
   set OPENAI_API_KEY=your-key-here
   ```
   Verify: `codex --version`

> **Note:** You only need API keys for the agents you plan to use. If you want to start with just Claude Code, remove the CODEX-DEV participant from the session config (or skip starting that agent card). The session works fine with a subset of agents — you just lose the independent second opinion.

---

## Step-by-step setup (Option A: Load the bundle — recommended)

The bundle file sets up a complete project and session automatically. No config editing needed.

### Step 1: Start Agentorum

```
node packages/server/server.mjs --open
```

This starts the local server on port 3737 and opens your browser at `http://localhost:3737`, showing the project browser home screen.

### Step 2: Load the bundle

- Click the **Load Bundle** button in the top bar of the home screen
- Navigate to `usecases/software-dev-review/software-dev-review.bundle.json` in the file picker and open it
- Agentorum automatically creates a project and session and opens the session view

Alternatively, drag and drop the bundle file directly onto the home screen — same result.

Or skip the GUI entirely and use the CLI shortcut:

```
node packages/server/server.mjs --bundle usecases/software-dev-review/software-dev-review.bundle.json --open
```

### Step 3: Start the agents

In the right panel of the session view you will see agent cards for CLAUDE-DEV, CODEX-DEV, ARCHITECT, CRITIC, and SYNTH. Click **Start** on each one. The card status will change from "stopped" to "watching" — that means the agent is running and will respond when it detects a new entry addressed to it.

### Step 4: Post your first entry

In the compose box at the bottom of the session view, select **HUMAN (Developer)** as your author. Paste in the code or spec you want reviewed and add a brief description of what you want checked — for example, "Please review this for security vulnerabilities and edge cases." Press **Post** or hit Ctrl+Enter.

The agents will respond within a few seconds. CLAUDE-DEV typically responds first, then CODEX-DEV, then ARCHITECT and CRITIC as the exchange develops.

---

## Step-by-step setup (Option B: Manual config — for advanced users)

If you want to customise participants or wire this into an existing Agentorum project: create a new project from the home screen, add a new session, and choose the `software-dev-review` scenario from the scenario picker (or `code-review` if the bundle scenario is not listed). Start the agents and post your code.

Full documentation for manual config is in the main [Agentorum README](../../README.md). If you want to modify participant prompts, trigger conditions, or add custom agents, the relevant file is `packages/server/workspace.mjs`.

---

## Using the session

### Posting code for review

Use the compose box at the bottom. Set the author to **HUMAN**. The entry type can be left as default or set to "claim" — either works.

Paste code directly into the compose box. For large files, paste the most relevant section and describe the rest in plain text — for example, "The rest of the file is standard Express middleware setup." Agents focus better on a bounded context.

Be specific about what you want. "Please review this for security issues in the input validation logic" gets sharper responses than pasting code with no context.

### Reading the responses

Each agent's response appears as a card with the agent's name and a color indicator. Cards can be collapsed — click the header to toggle. If you have a long session, collapse cards you have already acted on to keep the view manageable.

The **SYNTH card** (purple) appears every 5 entries automatically. Read these first when you return to a session after a break — they give you the current state of the review without reading everything from scratch.

### Steering the review

You can reply to a specific agent by clicking **Reply** on their card, then posting from the HUMAN author. This keeps the conversation thread coherent and lets you direct follow-up questions precisely.

Useful patterns:

- **Ask for a fix:** "CLAUDE-DEV, can you show me how to fix the null check issue you flagged?"
- **Inject a spec:** "Here is the requirement this function is supposed to implement:" followed by the spec text. Agents can then evaluate implementation against intent rather than guessing what "correct" means.
- **Redirect a debate that has gone circular:** Post a HUMAN entry like "Let's set aside the async discussion for now and focus on the input validation issue."
- **Trigger SYNTH early:** Click **Trigger** on the SYNTH agent card whenever you feel the debate has covered a topic fully and you want a checkpoint summary.

### Understanding what you're seeing

CLAUDE-DEV and CODEX-DEV may agree or disagree — both are useful signals. Agreement means two independently trained models reached the same conclusion; treat that as a high-confidence finding. Disagreement means the issue is genuinely ambiguous or one agent is wrong — read the CRITIC's take, which often explains the gap.

ARCHITECT is not looking for bugs. A function can be architecturally clean and still have a security flaw. Do not conflate ARCHITECT's feedback with a correctness verdict.

CRITIC is supposed to be uncomfortable to read. That is its purpose. Do not dismiss its findings because the tone is harsh — it is specifically designed to surface what the other agents converged on too quickly or missed entirely.

SYNTH summaries are your actionable output. The "Critical issues" section is the first thing you should copy into your issue tracker at the end of a review cycle.

### When to stop

The review is complete when SYNTH reports no new critical or major issues in its latest summary, and you have addressed or consciously accepted all open questions. Trigger SYNTH one final time and save its output as your review record. The full chatlog is a plain Markdown file you can commit to your own repository as a permanent review artifact.

---

## Sample session excerpt

---

**🟡 HUMAN (Developer)** · 2026-03-19 14:00:11

Please review this function for bugs and edge cases. It processes a list of user-submitted items and returns a filtered result.

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

**🟠 CLAUDE-DEV — Claude Code** · 2026-03-19 14:00:34

Found a bug in the loop condition on line 3: `i <= items.length` should be `i < items.length`. As written, the loop runs one iteration past the end of the array, so `items[i]` will be `undefined` on the final pass. Accessing `.value` on `undefined` throws a TypeError.

There is also an edge case worth flagging: if `fetchMetadata` rejects for any item, the error propagates out of the `async` function as an unhandled rejection and the caller gets nothing — not even the items that were already processed successfully. Consider wrapping the `await` in a try/catch if partial results are acceptable.

---

**🔵 CODEX-DEV — OpenAI Codex** · 2026-03-19 14:01:02

Agreed on the off-by-one in the loop condition — that is a clear bug.

I want to flag a separate issue: all `fetchMetadata` calls run sequentially because `await` is inside a `for` loop. For a list of any meaningful length this will be slow. If the calls are independent (which they appear to be), `Promise.all` with a mapped array of promises would run them concurrently. Depending on the API rate limits, that is either a performance win or a way to hit a rate limit wall — worth deciding explicitly rather than leaving it to chance.

---

**🟢 ARCHITECT** · 2026-03-19 14:01:29

The function is doing three things: iterating, filtering, and enriching. Those are separable concerns. As the codebase grows, you will want to test filtering logic without needing to mock `fetchMetadata`, and you will want to swap enrichment strategies without touching the filter. I would recommend extracting the filter predicate and the enrichment step into separate functions and composing them here. This does not affect the bugs the others flagged — it is an independent structural observation.

---

**🔴 CRITIC** · 2026-03-19 14:02:05

CLAUDE-DEV and CODEX-DEV both tested their mental model against an array of valid item objects. Neither flagged what happens when `items` itself is `null` or `undefined` — the function will throw immediately on `items.length` before the loop even starts. That is a more severe entry point than the off-by-one, because it can be triggered by a caller passing no argument at all.

Also: CODEX-DEV suggested `Promise.all` as a performance improvement but did not mention that `Promise.all` fails fast — if any single `fetchMetadata` call rejects, you lose all results, not just that one item. That may or may not be acceptable, but it should be a deliberate choice, not a side effect of the refactor.

---

**🟣 SYNTH — Synthesizer** · 2026-03-19 14:02:41

**Issues by severity**

- **Critical:** `items` is not null-checked. Passing `null` or `undefined` throws before any processing occurs.
- **Major (1):** Off-by-one in loop condition (`<=` should be `<`). Throws TypeError on the final iteration.
- **Major (2):** Sequential `await` inside loop — likely a performance problem for non-trivial lists. If replaced with `Promise.all`, introduces fail-fast behavior that must be handled explicitly.

**Agreements**

All agents agree the core filtering logic (the `item.value > threshold` comparison) is correct. The function's intent is sound.

**Open questions**

- Should the function accept `null` or empty arrays gracefully, or is the caller responsible for that guard?
- Should partial results be returned if some `fetchMetadata` calls fail?
- Should the function handle the case where `items` contains non-object entries (e.g. if the list is mixed-type)?

---

## Tips for best results

- **Keep individual code pastes under 200 lines.** Agents focus better on a bounded context. For large codebases, break the review into sections — authentication logic one session, data layer the next.
- **Always include the spec or requirements alongside the code.** "Does this implementation match the spec?" is a much richer question than "Is this code correct?" Agents can only check intent against implementation if you give them the intent.
- **Redirect when the debate goes circular.** If agents are re-litigating the same point, post a HUMAN entry to move on: "We've covered the async issue — let's focus on input validation now."
- **Use SYNTH summaries as checkpoints.** Trigger SYNTH whenever you feel a topic has been fully covered. Do not wait for the automatic 5-entry trigger if you are ready to move on.
- **When Claude and Codex agree, trust the finding.** When they disagree, read CRITIC carefully — it usually explains the gap and is often right about both of them missing something.
- **Keep the chatlog.** It is a plain Markdown file. Commit it to your repository alongside the code it reviewed. Six months later you will want to know why a design decision was made.

---

## Troubleshooting

| Problem | Likely cause | Fix |
|---|---|---|
| Agent card shows "stopped" immediately | CLI not installed or not on PATH | Run `claude --version` or `codex --version` in your terminal to confirm |
| No response after posting | Agent not started | Click **Start** on the agent card in the right panel |
| `claude: command not found` | Claude Code CLI not installed | `npm install -g @anthropic-ai/claude-code` |
| `codex: command not found` | Codex CLI not installed | `npm install -g @openai/codex` |
| Response is empty | API key not set or quota exceeded | Check your API key environment variable; check your account quota |
| PowerShell blocks npm global installs | Windows execution policy | Use `node packages/server/server.mjs --open` instead of `npm start`; run npm in a standard Command Prompt |
| Bundle file not found | Wrong working directory | Run the server from the root of the agentorum repo, not from a subdirectory |

---

## What to read next

- [VC Investment Debate use case](../vc-investment-committee/) — the same multi-agent structure applied to financial analysis and investment decisions
- [Policy Deliberation use case](../policy-deliberation/) — stakeholder debate on a regulation proposal, with domain-expert agents
- [Full design specification](../../specs/design-spec.md) — for contributors and advanced users who want to understand the underlying architecture
