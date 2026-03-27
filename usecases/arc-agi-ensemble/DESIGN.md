# ARC-AGI Ensemble — Design Document

## Overview

This system solves ARC-AGI puzzles using a multi-agent ensemble with a rule base. The core idea: separate *reasoning about the pattern* (text-only) from *executing the pattern* (deterministic code), and accumulate reusable knowledge across puzzle runs.

---

## Architecture

```
Round 0:  Rule Matching     — check rule base for known pattern
Round 1:  Solver(s)         — propose hypothesis in natural language (parallel if multiple)
Round 2:  MEDIATOR          — verify hypothesis against demos, write pseudo-code + optionally request new tools
          Tool Generator    — if new tools requested: generate Python, verify against demos, self-correct, register
Round 3:  EXECUTOR          — run pseudo-code deterministically against all demo pairs
          if all pass  →  apply to test input → done
          if fail      →  MEDIATOR revises (up to MAX_REVISIONS)
Final:    Rule Updates       — MEDIATOR writes/merges rules; auto-deprecate failing rules
```

---

## Key Design Principles

### 1. Reasoning and execution are strictly separated

Solvers and MEDIATOR never produce output grids. They produce *descriptions* and *pseudo-code*. EXECUTOR runs the actual transformations using deterministic Python tools. This separation means:
- Reasoning errors and implementation errors can be diagnosed independently
- The same pseudo-code can be re-run without repeating the reasoning step
- Tool correctness can be verified independently of the hypothesis

### 2. Verification before commitment

MEDIATOR is required to mentally trace every proposed pseudo-code sequence against **all demo pairs** before writing the output JSON. This is enforced in the prompt. If the trace reveals a mismatch, MEDIATOR must revise the hypothesis before committing. The goal: catch bad pseudo-code at reasoning time, not execution time.

### 3. Dynamic tool generation with demo-verified self-correction

When MEDIATOR needs a transformation that no existing tool can express, it requests a new tool via a `new_tools` JSON block. The tool generation loop:

1. MEDIATOR specifies `name`, `description`, `args`, `behavior` (precise natural language)
2. `run_tool_generator()` calls Claude with the spec **and the demo pairs** — giving the generator concrete input/output examples, not just prose
3. Generated Python is run against all demos deterministically
4. If any demo fails, the failing diff is sent back to Claude for self-correction (up to 3 attempts)
5. Only verified code is registered in `_TOOL_REGISTRY` and becomes available to EXECUTOR

**Why demo pairs matter**: English descriptions of geometric operations are ambiguous (inclusive vs exclusive endpoints, which cell is the corner, etc.). Concrete examples resolve the ambiguity the same way they do for MEDIATOR.

This is the mechanism that makes the system genuinely autonomous — it can acquire new capabilities without hand-coded tools.

### 4. Configurable solver ensemble

By default one solver (`SOLVER`) runs per puzzle. The solver prompt covers spatial, procedural, and analogical reasoning in a single pass. This is efficient for most puzzles.

For hard puzzles, switch to multiple specialist solvers:
```python
# In agents.py
DEFAULT_SOLVERS = ["SOLVER-SPATIAL", "SOLVER-PROCEDURAL", "SOLVER-ANALOGICAL"]
```
Or pass `solver_ids` to `run_ensemble()` at runtime. The three specialist prompts (`solver-spatial.md`, `solver-procedural.md`, `solver-analogical.md`) are preserved for this purpose.

**Why multiple solvers help (when they do)**: Different specialists notice different features. SPATIAL catches geometric structure; PROCEDURAL catches cell-by-cell formulas; ANALOGICAL matches to known transformation categories. If one is wrong, the others can outvote it. Most value on hard puzzles where the pattern is genuinely ambiguous.

**Why one solver is sufficient for easier puzzles**: The specialists tend to converge on the same answer when the pattern is clear. Three API calls for identical conclusions is waste. The combined `solver.md` prompt gets the same coverage in one call.

### 5. Rules as transferable knowledge

The rule base (`rules.json`) accumulates solved patterns across puzzle runs. After each puzzle:
- MEDIATOR writes rules describing the pattern it just solved
- Rules are structured as `condition → action` pairs with category tags
- On the next puzzle, Round 0 runs a matching pass — if a rule matches, MEDIATOR gets it as prior knowledge

**Rule quality principles** (enforced via prompt):
- Conditions begin with a category tag: `[gravity]`, `[path-drawing]`, `[proximity]`, etc.
- Conditions describe a *category* of puzzles, not a specific puzzle (no hardcoded colors, sizes, coordinates)
- Before writing `action: new`, MEDIATOR checks all existing rules — if a similar one exists, prefer `merge` or `generalize`
- `auto_deprecate()` runs after every puzzle: rules fired ≥3 times with 0 successes are deprecated automatically

**Rule lineage**: every rule records how it was created (`new`, `generalized`, `specialized`, `merged`, `consolidated`) and which parent rules it derived from. This allows tracing how knowledge evolves across puzzles.

### 6. Failure handling protocol (operator process)

When the system fails to solve a task autonomously, the correct operator response is **not** to provide the solution directly (e.g., via `--insight` or `--revision-hint`). That would mask the underlying capability gap and prevent the system from becoming self-sufficient.

The correct process is:

```
1. Understand the correct solution
   — Analyze the demo pairs manually (or ask the operator).
   — Identify the exact transformation rule, including any role asymmetries
     between different object groups (e.g., longest sequence vs. shorter ones).

2. Identify the system gap
   — Why did the solver not hypothesize the correct rule?
     (Missing reasoning step? Wrong default assumption? Bias toward simpler properties?)
   — Why did MEDIATOR fail to synthesize correct pseudo-code?
     (0 steps? Wrong tool requested? Tool behavior spec too vague?)
   — Why did the tool generator fail?
     (Too complex in one tool? Missing primitives? Namespace limitations?)
   — Was it a revision strategy failure?
     (MEDIATOR kept reusing the same broken tool across all revisions?)

3. Repair the gap
   — Fix prompts, tool generation context, revision strategy, or add builtin primitives
     as appropriate. The fix should address the *class of failure*, not the specific task.
   — Do NOT hardcode task-specific knowledge (e.g., exact color maps or coordinate offsets).
     The repair should generalize to structurally similar puzzles.

4. Validate autonomously
   — Re-run the failing task with NO hints. If it solves, the gap is repaired.
   — If it still fails, repeat from step 2 — the gap may be deeper or multiple gaps exist.
```

**Why this matters**: directly providing the solution via `--insight` produces a one-time fix that doesn't transfer. The system learns nothing about the *class of reasoning* it was missing. Gap-repair-first ensures that every hard puzzle makes the system permanently more capable — both for similar future puzzles (via task rules and improved prompts) and for different puzzles that share the same reasoning gap.

**When to use `--insight` legitimately**: only to trigger preference rule extraction after a correction event — i.e., after the gap has already been repaired and the task succeeds autonomously. The insight then documents *what the system was doing wrong before the repair*, not what it should do now.

### 7. Generalization policy

When a task rule is created, the post-success generalization pass asks MEDIATOR to propose broader candidate variants. Not every dimension of a rule should be generalized — the goal is to produce variants that will plausibly fire on structurally similar puzzles.

**What to generalize (free parameters):**
- Numeric thresholds that were inferred from a specific task (e.g., `max_size=2`, a particular color value)
- Conditions that reference specific colors by value rather than by role (e.g., "color 1 and 5" → "any non-background color")
- Positional descriptions that may not hold in all instances of the pattern class

**What NOT to generalize:**
- The core algorithm — if `recolor_small_components` is the right tool, that stays fixed
- Conditions that are essential to discriminate this pattern from others — removing them produces a rule that fires incorrectly on unrelated tasks
- Parameters whose variation would require a *different* tool, not just different arguments

**Generalization dimensions for common pattern classes:**

| Pattern class | Free parameters to generalize |
|---|---|
| Component-size recolor | `max_size` (threshold), `new_color`, background value |
| Diagonal radiation | Tip direction (topmost vs bottommost), number of sequences |
| Topology (hole count) | `object_color`, `color_map` values |
| Gravity / sorting | Direction (up/down/left/right), object selection criterion |
| Tiling / scaling | Scale factor, flip/rotation axis |
| Path drawing | Marker color, line color, connection rule |

**Candidate promotion policy:**
- New generalizations enter at `status: candidate`
- A candidate is promoted to `status: active` only after it fires and succeeds on a task different from its source task
- A candidate is auto-deprecated after 1 failure (stricter than active rules which allow 3)
- This prevents speculative generalizations from accumulating and polluting Round 0 matching

**Avoiding over-generalization:**
A rule that is too broad fires on tasks it cannot solve, accumulating failures and being deprecated. The right level of generality is: broad enough to cover the pattern class, specific enough to exclude unrelated patterns. When in doubt, prefer a narrower condition — it is easier to broaden later than to recover from a rule that fires incorrectly everywhere.

### 8. Human-in-the-loop is optional and non-blocking (for hints)

Prefilled hints (`--hypothesis`, `--insight`, `--revision-hint`) inject at checkpoints without waiting. If not provided, the system runs fully autonomously. The design intent: hints should *accelerate* convergence, not be required for correctness. A hint that is wrong can actively mislead MEDIATOR — the system does not yet have a mechanism to reject bad hints.

**Current guidance**: provide no hints by default. Only intervene if MEDIATOR's hypothesis is clearly wrong after Round 1 or fails all demos across multiple revisions.

### 7. Human-natural reasoning preference

ARC-AGI-V2 evaluation has an important property: when multiple transformation rules fit all demo pairs equally well, the one that is **preferred by humans** is considered correct. This systematically excludes solutions that are computationally convenient but unlikely to be considered by a human solver — e.g. "recolor objects where bounding box area > 12" vs "recolor objects with a hole in them."

The solver currently has no built-in preference for human-natural over computationally-natural hypotheses. This creates a failure mode: the solver picks the hypothesis that is easiest to express as code, which often differs from the one a human would reach first.

**Human-natural properties** (humans perceive these first):
- Topological structure (number of enclosed holes, connectedness, shape identity)
- Perceptual grouping (proximity, color, orientation)
- Relative position (left/right of divider, inside/outside boundary)
- Symmetry and reflection

**Non-human-natural properties** (easy to compute, hard to eyeball):
- Exact pixel/cell count
- Bounding box area or aspect ratio
- Lexicographic ordering of color values

This principle cannot be fully solved by hardcoding a preference list — such a list would be incomplete, potentially wrong, and wouldn't transfer to new puzzle categories. Instead, preferences are **learned from corrections** (see §8).

### 8. Preference rules: learning from corrections (after gap repair)

When the system gets a puzzle wrong and a human correction succeeds, that is a training event:

```
wrong_hypothesis → human insight → correct_hypothesis → success
```

The system extracts a **preference rule** from this triple: not a solution for the specific puzzle, but a general reasoning bias about *which hypothesis property to prefer* when evidence is ambiguous.

**Preference rules vs task rules**:

| Property | Task rule | Preference rule |
|---|---|---|
| Encodes | How to solve puzzle type X | Which hypothesis property to prefer |
| Applied | Per-puzzle (matched in Round 0) | Every puzzle (universal soft prior) |
| Created by | MEDIATOR after solving | MEDIATOR after correction event |
| Triggered by | Normal task completion | `--insight` used + task succeeded |
| Overridable | By stronger matching rules | By demo evidence or future corrections |

**Key design constraints**:
- Preferences are **soft priors**, not mandates. The solver is explicitly told: "demo evidence overrides a prior." A future puzzle can provide counter-evidence that causes the prior to be revised.
- Preferences are **not hardcoded by the developers**. They emerge from observed correction events. A developer-imposed preference list would embed developer assumptions (potentially wrong) and wouldn't generalize.
- Preferences **accumulate and can be revised**. If a preference rule leads the solver astray on a future puzzle, that failure generates a correction that specializes or contradicts the prior — just as a human refines intuitions from experience.

**Long-term alignment significance**: This mechanism models how human preferences are transferred to an AI system — not by explicit rule specification, but by observing corrections and learning what the corrector cares about. The same architecture that learns "prefer topology over pixel count for ARC-AGI" can in principle learn "prefer fairness over efficiency in resource allocation" from social corrections. The goal is a system that models the *cognitive process* a human uses, not just a lookup table of known preferences.

---

## File Map

| File | Role |
|------|------|
| `python/harness.py` | CLI entry point; parses args, loads tasks, calls `run_ensemble()` |
| `python/ensemble.py` | Main orchestrator; runs all rounds, manages rule updates |
| `python/agents.py` | All LLM calls (solvers, MEDIATOR, tool generator); retry on 529 |
| `python/executor.py` | Deterministic tool runner; parses pseudo-code JSON; registers dynamic tools |
| `python/grid_tools.py` | Grid transformation tools (`gravity`, `flood_fill`, `gravity_by_type`, etc.) |
| `python/rules.py` | `RuleEngine`: CRUD, matching, prompt builders, auto-deprecation |
| `python/display.py` | Rich terminal UI; prefilled checkpoint injection |
| `python/metadata.py` | Data classes (`SolverEntry`, `MediatorDecision`, `TaskMetadata`) |
| `prompts/solver.md` | Combined solver prompt (spatial + procedural + analogical) |
| `prompts/solver-spatial.md` | Specialist: geometric/visual reasoning |
| `prompts/solver-procedural.md` | Specialist: cell-by-cell algorithmic reasoning |
| `prompts/solver-analogical.md` | Specialist: classification by known transformation category |
| `prompts/mediator.md` | MEDIATOR: verification, pseudo-code synthesis, rule management, tool requests |
| `python/rules.json` | Runtime rule base (gitignored — per-environment state) |

---

## Known Limitations and Future Work

### Human hint trust
MEDIATOR currently trusts human hints unconditionally. A wrong hint is worse than no hint because MEDIATOR spends revision budget trying to reconcile the hint with the demos. **Future**: give MEDIATOR explicit permission to reject or downweight a human hint if it contradicts the demo evidence.

### Preference rule quality
Preference rules are extracted by MEDIATOR from correction events, which means their quality depends on MEDIATOR's ability to generalize correctly from a single example. A rule extracted too specifically will fail to transfer; a rule extracted too broadly may suppress correct hypotheses. **Future**: validate preference rules by re-running past puzzles with and without the new prior; only retain rules that improve accuracy on held-out tasks.

### Solver asymmetric role blindness
The solver may treat all non-zero groups as having the same role, missing cases where different groups transform differently based on a property like length rank, position, or color. The solver prompt now explicitly asks "do all groups transform identically or do different groups have different roles?" — but the solver may still converge on a symmetric description when an asymmetric one is correct. **Future**: add a solver reasoning step that explicitly enumerates all observable group properties (length, orientation, color, position) and tests whether those properties predict which groups have which behavior.

### Rule matching reliability
Rule matching uses an LLM call (MEDIATOR reads all rules as text and decides which apply). This can miss matches or produce false positives. **Future**: structured condition predicates (object count, color set, grid shape, transformation category) that can be matched programmatically before the LLM pass.

### Generated tool persistence
Dynamically generated tools are registered at runtime but not saved to disk. If a tool was useful for puzzle A and puzzle B has a similar pattern, the tool must be regenerated. **Future**: persist verified tool code alongside rules.json so tools accumulate across runs.

### Solver diversity
Currently, using multiple solvers with the same underlying model (Sonnet 4.6) provides limited diversity — they tend to notice the same features. **Future**: plug in different model families (e.g., Opus for deep spatial reasoning, a fine-tuned ARC specialist) as distinct solvers when the single-solver fails.

### Leaderboard tracking
The harness writes per-run stats to `results.json`. Full leaderboard submission requires: dataset split (training vs evaluation vs test), no human hints used, reproducible results. Track `human_hints_used` per task in the results.

---

## Running the System

```bash
# Single puzzle
bash usecases/arc-agi-ensemble/run-python.sh --task-id 0e671a1a

# Batch run (V2-only tasks, offset 30, 10 tasks)
bash usecases/arc-agi-ensemble/run-python.sh --skip-ids python/v1_ids.json --offset 30 --limit 10

# With human insight
bash usecases/arc-agi-ensemble/run-python.sh --task-id 0a2355a6 --insight "topological hole count"

# Override revision count (useful during debugging to cap API spend)
bash usecases/arc-agi-ensemble/run-python.sh --task-id 0e671a1a --max-revisions 2

# Show all agent prompts and MEDIATOR output
bash usecases/arc-agi-ensemble/run-python.sh --task-id 0e671a1a --prompts
```

## Performance Stats

`stats.py` aggregates results across all saved result files and prints a structured report. Run it any time to review system health:

```bash
# Full report (all sections)
bash usecases/arc-agi-ensemble/run-python.sh --stats

# Single section
bash usecases/arc-agi-ensemble/run-python.sh --stats --section rules
bash usecases/arc-agi-ensemble/run-python.sh --stats --section failed
bash usecases/arc-agi-ensemble/run-python.sh --stats --section generalization
bash usecases/arc-agi-ensemble/run-python.sh --stats --section methods
bash usecases/arc-agi-ensemble/run-python.sh --stats --section cost

# Rules + generalization only (no task results needed)
bash usecases/arc-agi-ensemble/run-python.sh --stats --rules-only

# Specific result files
bash usecases/arc-agi-ensemble/run-python.sh --stats python/results_v2_21_30.json
```

### Sections reported

| Section | Contents |
|---|---|
| **Overview** | Total tasks, correct/failed counts, accuracy |
| **Methods** | How tasks were solved: rule-matched vs dynamic-tool vs solver-only, with task IDs |
| **Rules** | Rule base size, lineage breakdown, fire→success rate, per-rule stats sorted by successes |
| **Generalization** | Generalized/merged/candidate rule counts, which generalizations have fired and on which tasks |
| **Tools** | All dynamically generated tools, whether each contributed to a solution, task associations |
| **Cost** | Total + per-task cost, avg duration, token breakdown, API call counts |
| **Failed** | Failed task list with cell accuracy, rounds, cost, tools tried, rules matched |

### Note on result file coverage

Each harness run writes results to `results.json` (or `--output <file>`). The stats reporter auto-discovers `results.json`, `results_v2_21_30.json`, `results_v2_31_35.json` in the `python/` directory and deduplicates by task ID. To include a new batch, either use the default output path or pass the file path explicitly. Tasks run before result-file persistence was added are not recoverable in structured form — consult `SOLVE_LOG.md` for narrative history of those runs.
