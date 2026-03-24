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

### 6. Human-in-the-loop is optional and non-blocking

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

### 8. Preference rules: learning from corrections

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

### Solver property uniqueness blindness
The solver does not currently reason about whether a hypothesized property *uniquely* discriminates the objects that change vs those that don't. For example, if objects differ in both size AND topology, the solver may latch onto size because it's more obvious to describe — but topology might be the discriminating property. **Future**: add a solver reasoning step that enumerates all observable differences and asks "which of these properties is *unique* to the changed objects?" before committing to a hypothesis.

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

```powershell
# From agentorum root — single puzzle, no hints
node usecases/arc-agi-ensemble/run-python.mjs --task 0e671a1a

# With hints (use .private/ scripts per puzzle)
.\.private\arc-ac2e8ecf.ps1

# Batch run (first 10 training puzzles)
node usecases/arc-agi-ensemble/run-python.mjs --limit 10

# Override revision count
node usecases/arc-agi-ensemble/run-python.mjs --task 0e671a1a --max-revisions 3
```
