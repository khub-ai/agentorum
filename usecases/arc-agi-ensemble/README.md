# ARC-AGI Ensemble

A 5-agent ensemble that solves [ARC-AGI-2](https://arcprize.org/) abstract reasoning puzzles through structured adversarial debate. The ensemble exposes a single synchronous REST endpoint — from the outside, it behaves like one agent.

## The idea

ARC-AGI puzzles require discovering a transformation rule from a few input→output demonstration pairs, then applying that rule to a new input. Single LLMs struggle because they commit to one interpretation early and can't escape it. An ensemble of agents with different reasoning styles can:

1. **Propose multiple hypotheses** — three solvers approach the same puzzle from different angles
2. **Catch errors** — a dedicated CRITIC verifies each proposal against ALL demo pairs
3. **Refine through debate** — solvers read each other's proposals and CRITIC's feedback, then revise
4. **Make a final decision** — a MEDIATOR weighs the evidence and produces the answer

## Agents

| Agent | Approach | Role in debate |
|---|---|---|
| **SOLVER-SPATIAL** | Visual/geometric reasoning (symmetry, rotation, gravity) | Proposes a rule, defends or revises after criticism |
| **SOLVER-PROCEDURAL** | Step-by-step algorithms (for-each-cell rules, coordinate math) | Proposes a rule, defends or revises after criticism |
| **SOLVER-ANALOGICAL** | Pattern classification (flood-fill? stamp? sort? extraction?) | Proposes a rule, defends or revises after criticism |
| **CRITIC** | Verification — tests each rule against every demo pair | Reports PASS/FAIL per solver, identifies specific failing cells |
| **MEDIATOR** | Final decision + knowledge generalization | Picks the best-supported answer, extracts lessons for future tasks, can inject human insights into the debate |

The MEDIATOR was originally named "JUDGE" but was renamed to reflect its broader mandate: it does not just decide — it also **generalizes patterns into a growing knowledge base**, applies knowledge from prior tasks, guides debate direction, and can escalate to a human when the ensemble is stuck.

## Debate protocol

```
Round 1:  Three solvers independently propose a rule + output grid     (parallel)
          → Convergence check: if all three agree, CRITIC confirms
Round 2:  CRITIC evaluates each proposal against all demo pairs
Round 3:  Solvers revise based on CRITIC feedback + each other's work  (parallel)
Round 4:  MEDIATOR reads full debate, produces final answer + updates KB
```

If all solvers converge in Round 1 and CRITIC confirms, the debate short-circuits to save cost.

## Design decisions

### Reasoning only — no code execution (for now)

The solvers reason about grids in natural language + JSON. Python tooling exists (see `python/grid_tools.py`) for post-hoc analysis and evaluation, but the agents themselves do not execute code during the debate. This was chosen to:
- Keep the debate fast and cost-predictable
- Avoid the complexity of sandboxed execution in Round 1
- Let the ensemble validate itself — if code were the oracle, it would undercut the debate

Python code execution for solvers can be added in a later phase once the pure-reasoning baseline is established.

### Human is part of the ensemble

For research and evaluation runs, a human operator may inject insights into the debate at any point. Two mechanisms:
1. **Stalemate detection** — if the ensemble fails to converge after Round 3, the Python harness can pause and prompt the operator for a hint before the MEDIATOR makes its final call
2. **Knowledge base seeding** — human insights can be added to `knowledge.json` directly and will be read by all agents at the start of the next task

This mirrors how expert human judgment is still invaluable even when the AI ensemble is capable.

### Knowledge Fabric

The MEDIATOR writes generalizable lessons to a persistent `knowledge.json` after each solved puzzle. Future tasks start with this context, so the ensemble accumulates transferable knowledge across runs:

```json
{
  "patterns": [
    { "name": "column-gravity", "description": "Non-background cells fall to the bottom of their column.",
      "trigger_cues": ["floating cells", "consistent downward shift"], "confirmed_tasks": ["1e0a9b12"] }
  ],
  "failure_modes": [
    { "description": "Mistook row-gravity for column-gravity on symmetric input.",
      "lesson": "Always check BOTH axes in the demo pairs." }
  ],
  "human_insights": []
}
```

### Python for research tooling, Node.js for the API server

| Layer | Language | Reason |
|---|---|---|
| Agentorum UI + `/api/ensemble` REST endpoint | Node.js | Already exists; integrates with the broader platform |
| Test harness, grid tools, evaluation, visualization | Python | numpy, matplotlib, rich — better fit for data science work |

When deeper UI integration is needed, the Python tooling can be exposed as a microservice with the Node server proxying to it.

## API endpoint (Node.js / Agentorum)

```
POST /api/ensemble
Content-Type: application/json

{
  "task": {
    "train": [
      { "input": [[0,1],[1,0]], "output": [[1,0],[0,1]] }
    ],
    "test": [
      { "input": [[0,0,1],[0,1,0],[1,0,0]] }
    ]
  },
  "context": "optional: learnings from previous tasks",
  "config": {
    "maxRounds": 4,
    "convergenceEnabled": true
  }
}
```

**Response:**
```json
{
  "answer": [[1,1,0],[1,0,1],[0,1,1]],
  "debate": [
    { "round": 1, "agent": "SOLVER-SPATIAL", "content": "..." },
    { "round": 1, "agent": "SOLVER-PROCEDURAL", "content": "..." },
    "..."
  ],
  "metadata": {
    "rounds": 4,
    "converged": false,
    "durationMs": 28400,
    "agents": 5
  }
}
```

## Running the Node test harness

Prerequisites:
- Agentorum server running (`npm start` from `packages/server/`)
- `ANTHROPIC_API_KEY` environment variable set
- ARC-AGI-2 training data in JSON format

```bash
# Run a single task (default)
node usecases/arc-agi-ensemble/test-harness.mjs

# Run a specific task by ID
node usecases/arc-agi-ensemble/test-harness.mjs --task-id 1e0a9b12

# Run first 10 tasks
node usecases/arc-agi-ensemble/test-harness.mjs --limit 10

# Custom data directory and server
node usecases/arc-agi-ensemble/test-harness.mjs \
  --data-dir /path/to/arctest2025/data/training \
  --server http://localhost:4800 \
  --limit 5 --output my-results.json
```

## Running the Python harness (research)

Prerequisites:
- Python 3.10+ with packages from `python/requirements.txt`
- `ANTHROPIC_API_KEY` environment variable set

```bash
cd usecases/arc-agi-ensemble/python

# Install dependencies (first time)
pip install -r requirements.txt

# Run a single task
python harness.py --task-id 1e0a9b12

# Run 10 tasks with charts saved per task
python harness.py --limit 10 --charts --charts-dir charts/

# Enable human-in-the-loop on stalemates
python harness.py --limit 20 --human --output results.json
```

### Visualizations

The Python harness can generate four chart types:

| Chart | Description |
|---|---|
| **Hypothesis Grid Evolution** | Each solver's proposed grid at R1 and R3, next to the expected output |
| **Debate Flow Diagram** | Agent × round timeline with confidence/PASS/FAIL coloring |
| **Learning Curve** | Cumulative accuracy and cell accuracy over tasks, with KB pattern count overlay |
| **Ensemble vs Solo** | Bar chart comparing ensemble accuracy against individual solver baselines |

## First test result

Task `1e0a9b12` (column-wise gravity, 5×5 grid, 3 demo pairs):
- All three solvers **converged in Round 1**
- CRITIC **confirmed** — Round 3 skipped (convergence shortcut triggered)
- MEDIATOR produced the correct answer
- Duration: **40.7 seconds**  ✓ CORRECT

## Cost estimate

Each task requires 8 API calls in the full 4-round protocol (3 solvers × 2 rounds + CRITIC + MEDIATOR). Early convergence reduces this to 5 calls. With Claude Sonnet at ~$3/MTok input, ~$15/MTok output:

| Scale | Estimated cost | Duration |
|---|---|---|
| 1 task | ~$0.10–0.25 | ~30–60 seconds |
| 10 tasks | ~$1–2.50 | ~5–10 minutes |
| 100 tasks | ~$10–25 | ~50–100 minutes |
| 400 tasks (full eval) | ~$40–100 | ~3–7 hours |

Convergence shortcut reduces cost on easy tasks (where all solvers agree immediately).

## Files

```
usecases/arc-agi-ensemble/
├── README.md                          ← this file
├── arc-agi-ensemble.scenario.json     ← scenario configuration (Agentorum)
├── test-harness.mjs                   ← Node.js automated test runner
├── prompts/
│   ├── solver-spatial.md              ← visual/geometric reasoning
│   ├── solver-procedural.md           ← algorithmic step-by-step reasoning
│   ├── solver-analogical.md           ← pattern classification reasoning
│   ├── critic.md                      ← verification and challenge
│   └── mediator.md                    ← final decision + knowledge extraction
└── python/                            ← research tooling (standalone)
    ├── requirements.txt
    ├── harness.py                     ← CLI test runner
    ├── ensemble.py                    ← debate orchestrator
    ├── agents.py                      ← async Anthropic API calls per agent
    ├── grid_tools.py                  ← numpy grid operations
    ├── knowledge.py                   ← persistent knowledge base
    ├── metadata.py                    ← structured per-round metadata capture
    └── visualize.py                   ← matplotlib/plotly charts
```
