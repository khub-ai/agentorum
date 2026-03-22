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
| **MEDIATOR** | Final decision + knowledge generalization | Picks the best-supported answer, extracts lessons for future tasks |

## Debate protocol

```
Round 1:  Three solvers independently propose a rule + output grid     (parallel)
          → Convergence check: if all three agree, CRITIC confirms
Round 2:  CRITIC evaluates each proposal against all demo pairs
Round 3:  Solvers revise based on CRITIC feedback + each other's work  (parallel)
Round 4:  MEDIATOR reads full debate, produces final answer
```

If all solvers converge in Round 1 and CRITIC confirms, the debate short-circuits to save cost.

## API endpoint

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
    ...
  ],
  "metadata": {
    "rounds": 4,
    "converged": false,
    "durationMs": 28400,
    "agents": 5
  }
}
```

## Running the test harness

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

## Cost estimate

Each task requires 8 API calls in the full 4-round protocol (3 solvers × 2 rounds + CRITIC + MEDIATOR). With Claude Sonnet at ~$3/MTok input, ~$15/MTok output:

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
├── arc-agi-ensemble.scenario.json     ← scenario configuration
├── test-harness.mjs                   ← automated test runner
└── prompts/
    ├── solver-spatial.md              ← visual/geometric reasoning
    ├── solver-procedural.md           ← algorithmic step-by-step reasoning
    ├── solver-analogical.md           ← pattern classification reasoning
    ├── critic.md                      ← verification and challenge
    └── mediator.md                    ← final decision + knowledge extraction
```
