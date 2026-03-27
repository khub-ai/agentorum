# ARC-AGI Ensemble — Learnings Log

A living record of system failures, root cause analyses, fixes applied, and design insights gained. Each entry documents not just what broke and how it was repaired, but *why* the gap existed and how the repair generalizes to future tasks. This document is the primary reference for understanding how the system's capability evolved over time.

---

## How to read this document

Each failure event has five fields:
- **Failure**: what the system did wrong
- **Root cause**: the specific gap — in a prompt, a tool, the rule base, or the architecture
- **Fix**: what was changed
- **Generalization**: how future tasks benefit from this fix (beyond the one task that exposed it)
- **Design insight**: the broader principle learned

Entries are grouped by failure *type*, not by task, so patterns across tasks are visible. Cross-references link to individual case study articles in `.private/`.

---

## Failure type 1: Solver reasoning gaps (wrong or incomplete hypothesis)

### 1.1 Solver assumes symmetric roles for all non-zero groups

**Exposed by**: `1190bc91` (sequence radiation)
**Case study**: `.private/1190bc91.md`

**Failure**: SOLVER described "each sequence radiates diagonally" — treating all sequences identically. Missed that the longest sequence has a different role (spine → diagonal radiation) from shorter sequences (peripheral → BFS expansion).

**Root cause**: The solver prompt had no step asking whether different groups play different roles. Default assumption is symmetric: all non-zero groups transform the same way.

**Fix**: Added Step 3 to solver.md analysis protocol:
> *"Ask explicitly: do all non-zero groups transform the same way, or do different groups play different roles? Look for properties that could assign roles: length/size, position, color, orientation, rank."*

**Generalization**: Any puzzle where objects have different roles based on a measurable property (size rank, position, distance from center, color uniqueness) will now be caught. Relevant for object-manipulation, sorting, gravity-by-type, and classification puzzles.

**Design insight**: The solver's default is symmetric reasoning — it describes what the majority of cells do and assumes the rest follow the same rule. Asymmetric roles require an explicit prompt to look for outliers and hypothesize a discriminating property. This is a general bias to counteract.

---

### 1.2 Solver misses ordering / sequential processing constraints

**Exposed by**: `1190bc91` (sequence radiation)
**Case study**: `.private/1190bc91.md`

**Failure**: SOLVER described diagonal radiation from the spine sequence without noticing that elements are processed tip-to-end sequentially, with already-filled cells acting as barriers for subsequent elements and for peripheral sequence expansion.

**Root cause**: The solver reasons statically about the final output state. It doesn't naturally consider *when* each cell was set relative to other cells. Ordering only reveals itself through *contested cells* — cells reachable from multiple sources where one source's color wins. The solver prompt never asked for this analysis.

**Fix**: Added Step 4 to solver.md analysis protocol:
> *"Identify contested cells — output cells reachable from multiple sources. Which source's color appears? Is there a consistent priority/ordering rule? Does simultaneous vs sequential interpretation produce different results — commit to the correct one."*

Also added to solver.md "In later rounds" revision section and to the MEDIATOR revision prompt in agents.py.

**Generalization**: Any puzzle with multiple sources that could claim the same cell needs this analysis: radiation puzzles, BFS expansion, beam projection, gravity with multiple objects, path drawing with intersections. The contested-cell test is the universal diagnostic.

**Design insight**: Static output description ≠ algorithmic description. The solver needs to reason about execution order when transformations interact. The signal is always in the contested cells — they carry information about priority that non-contested cells do not.

---

### 1.3 Solver uses wrong discriminating property (size vs topology)

**Exposed by**: `0a2355a6` (hole count recoloring)

**Failure**: SOLVER hypothesized that objects are recolored by size rank (number of cells), when the correct property is topological hole count (number of enclosed holes).

**Root cause**: Size rank is visually salient and immediately computable. Topological properties (hole count) require a more abstract analysis step. The solver defaulted to the more obvious property.

**Fix**: Preference rule `r_085` extracted via `--insight "topological hole count"` after the gap was diagnosed. Rule encodes: "when objects have different hole counts, prefer topology over size as the discriminating property."

Also added `recolor_by_hole_count` as a verified builtin with `color_map` parameter.

**Generalization**: Preference rules generalize the lesson: whenever objects have both size-based and topology-based differences, the system now has a prior favoring topology. Future tasks with hole-count discrimination will match this preference before the solver even runs.

**Design insight**: When the solver picks a plausible-but-wrong property, the right fix is a *preference rule*, not a task rule. A task rule would only fire on identical patterns; a preference rule shapes the solver's reasoning across all structurally similar tasks.

---

## Failure type 2: MEDIATOR produces 0 pseudocode steps

### 2.1 Conflicting rules in rule base paralyze MEDIATOR

**Exposed by**: `0a2355a6` and `1190bc91` (multiple retry runs)

**Failure**: MEDIATOR produced 0 pseudocode steps — `parse_pseudocode()` returned an empty list. Task automatically failed.

**Root cause**: Multiple retry runs had accumulated conflicting rules for the same task (e.g., `r_082`, `r_083`, `r_084` all matched the same pattern but specified contradicting `color_map` values). MEDIATOR saw high-confidence rules with contradicting actions and produced long reasoning text without committing to pseudocode.

**Fix**:
1. Deprecated conflicting rules manually.
2. Added mandatory instruction to MEDIATOR prompt: *"Zero steps is never acceptable — you must always produce pseudocode or explicitly request a new tool."*
3. Added `failed_tools` tracking to revision loop so MEDIATOR knows which tools have already failed.

**Generalization**: The 0-steps failure mode is now explicitly prevented. MEDIATOR must always produce either a pseudocode block or a tool-request block. Rule conflicts that could cause paralysis are now caught earlier via the conflict detection in `rules.py`.

**Design insight**: When MEDIATOR is given two high-confidence contradicting instructions, it reasons but doesn't decide. The fix is twofold: prevent contradicting rules from accumulating (better deprecation), and make 0-step output a hard error (prompt constraint). Both are needed — the prompt constraint alone doesn't fix the underlying rule quality issue.

---

### 2.2 MEDIATOR can't synthesize pseudocode when no tool matches the hypothesis

**Exposed by**: `1190bc91` (sequence radiation)

**Failure**: Even when MEDIATOR didn't produce 0 steps, it defaulted to requesting `radiate_sequences` from the tool generator — which then failed all fix attempts because the algorithm was too complex to implement from a monolithic natural-language spec.

**Root cause**: No existing tool matched the two-phase algorithm. MEDIATOR's options were: (1) request a new tool (which failed), or (2) produce 0 steps (now prevented). Neither worked. The real gap was that the algorithm decomposes into two conceptually distinct sub-algorithms that can't be reliably fused into one tool spec.

**Fix**:
1. Implemented `radiate_sequences` as a verified builtin (Phase 1: diagonal radiation, Phase 2: BFS expansion). This bypasses the tool generator entirely for this pattern class.
2. Added rule `r_102` so MEDIATOR can match the pattern in Round 0 without needing the solver to discover it.

**Generalization**: When a puzzle's algorithm decomposes into two distinct sub-algorithms, the tool generator will likely fail regardless of how many attempts it gets — because it has no mechanism to discover the decomposition from a failing cell diff. The correct fix is to implement a builtin that encodes the decomposition correctly, then expose it via the rule base.

**Design insight**: The tool generator is effective for single-algorithm transformations with clear input/output semantics. It fails systematically for multi-phase algorithms where each phase has different logic. The signal: tool generator fails all 3–5 fix attempts with cell accuracy that fluctuates rather than converges. When this happens, the fix is a builtin, not more fix attempts.

---

## Failure type 3: Tool generator failures

### 3.1 Dynamically generated tool hardcodes task-specific parameters

**Exposed by**: `12eac192` (small component recoloring)
**Case study**: `.private/12eac192.md`

**Failure** (latent, caught before running): The dynamically generated `recolor_small_components` tool in the registry hardcoded `target_val in [1, 5, 8, 7]`. This would have worked for task 12eac192 but silently failed on any task with different colors.

**Root cause**: The tool generator produces code that passes the specific demo pairs it was verified against. It has no incentive to generalize beyond those demos — and no mechanism to test generalization. Hardcoded values that happen to match the demos look correct to the verifier.

**Fix**: Implemented `recolor_small_components` as a proper builtin that processes ALL non-background colors (determined by `background` parameter, not hardcoded), with `max_size` and `new_color` as explicit parameters inferred from demos.

**Generalization**: Any future task in the "small components → recolor" class will use the builtin regardless of which colors are involved. The mediator.md entry instructs MEDIATOR to infer `max_size` and `new_color` from demos, not use defaults blindly.

**Design insight**: Dynamically generated tools that pass demos by hardcoding demo-specific constants are a hidden reliability risk. The tool generator should be prompted to parameterize any value that appears in the demos rather than hardcoding it. **Future**: add a tool verification step that runs the generated tool against a color-shifted version of the demos — if it fails, the tool is hardcoding colors.

---

### 3.2 Revision loop reuses the same failing tool under a new name

**Exposed by**: `1190bc91` (multiple `diagonal_*` tool variants)

**Failure**: Across 5 revision attempts, MEDIATOR kept requesting variations of the same `diagonal_sequence_radiation` tool (`_v2`, `_fixed`, `_nearest`, `_v2`). Each new tool had different bugs. No progress toward the correct algorithm.

**Root cause**: The revision prompt told MEDIATOR to "fix the pseudocode" but didn't prevent it from requesting the same conceptually broken approach repeatedly. MEDIATOR had no memory of which approaches had already failed.

**Fix**: Added `failed_tools` list tracking across all revisions. Revision prompt now includes: *"Do NOT reuse any of these tools. Try a different decomposition."* Also added to MEDIATOR revision prompt: *"If the same tool has failed twice, try a fundamentally different decomposition."*

**Generalization**: Any future task where the first tool approach is wrong will now switch approaches after 2 failures rather than cycling through variations of the same broken idea. This reduces wasted API calls and prevents tool registry pollution.

**Design insight**: The revision loop without memory is a local search with no escape from local minima. The failed_tools list is a minimal memory mechanism. A stronger version would track not just tool names but the *approach* (e.g., "single-tool diagonal radiation") so that MEDIATOR avoids entire families of approaches, not just specific tool names.

---

## Failure type 4: Rule base quality issues

### 4.1 Wrong lesson extracted from correction event

**Exposed by**: `0a2355a6` (hole count recoloring), first correction attempt

**Failure**: After running with `--insight "topological hole count"`, MEDIATOR extracted a preference rule about tie-breaking by spatial position instead of the intended lesson (prefer topology over size as discriminating property).

**Root cause**: When `--insight` is provided before Round 1, the solver may already hypothesize correctly (because the tool name `recolor_by_hole_count` is visible in tool signatures). So the "wrong hypothesis" that the preference rule should correct was actually the correct hypothesis — and the extractor extracted a vacuous or wrong lesson.

**Fix**: Added `failed_hypotheses.json` sidecar to store the solver's hypotheses from prior *failed* runs. When `--insight` fires, the wrong hypotheses are loaded from the sidecar rather than from the current (potentially already-correct) Round 1 entries.

**Generalization**: Preference rule extraction is now correctly anchored to what was actually wrong in previous runs, not what the solver happens to say in the current run (which may already be correct due to the insight hint).

**Design insight**: The correction event has a temporal structure: the wrong hypothesis came from an earlier run; the insight comes now. Mixing them up produces a rule that tries to correct the right hypothesis instead of the wrong one. The sidecar pattern (persist wrong state from failed run, consume it in correction run) solves this cleanly.

---

### 4.2 Rule base accumulates conflicting rules from retry runs

**Exposed by**: `0a2355a6`, `1190bc91` (multiple retry runs each)

**Failure**: Each failed retry run created a new rule with a slightly different (wrong) `color_map` or tool spec. After 3–4 retries, the rule base had 3–4 conflicting rules all matching the same task pattern with contradicting actions.

**Root cause**: MEDIATOR creates a new rule after every run (including failed runs where it got a partial result). There was no deduplication or conflict detection between rules from the same task.

**Fix**:
1. `auto_deprecate()` now runs after every puzzle — rules fired ≥3 times with 0 successes are deprecated.
2. Rule conflict detection added: when two active rules share the same source_task and same action tool, flag them for review.
3. Operator manual review of rules.json after persistent failures.

**Generalization**: The rule base stays clean across all tasks. Retry-run artifacts are caught and deprecated before they accumulate to the point of paralysis.

**Design insight**: The rule base is only as useful as its signal-to-noise ratio. Every conflicting rule degrades the quality of Round 0 matching for all future tasks. Strict deprecation and conflict detection are essential maintenance operations, not optional cleanup.

---

## Design directions suggested by this log

### Direction 1: Contested-cell analysis as a first-class reasoning primitive
The ordering gap (1.2) reveals that static output description is insufficient for interaction-based transformations. A dedicated reasoning module that identifies contested cells, tests parallel vs sequential interpretations, and infers priority rules would address this systematically. This is likely one of the most broadly applicable missing capabilities.

### Direction 2: Tool generator quality gates
The hardcoded-parameter failure (3.1) suggests adding a post-generation test: run the generated tool on a color-shifted or size-scaled variant of the demos. Tools that fail this test are flagged as potentially brittle. This prevents silent reliability degradation in the tool registry.

### Direction 3: Approach-level memory in revision loop
The reuse-of-failing-approach failure (3.2) is only half-fixed by the `failed_tools` list. A stronger fix tracks the *approach category* (single-tool radiation, Chebyshev expansion, etc.) so MEDIATOR avoids entire families. This requires classifying failed approaches semantically, not just by tool name.

### Direction 4: Rule quality validation via held-out tasks
Preference rules and generalized rules are currently validated only on the task that triggered them. A background validation pass that runs each new rule against 2–3 randomly selected prior tasks would catch rules that are either too narrow (never fire) or too broad (fire and fail). This is the "held-out task" validation mentioned in Known Limitations.

### Direction 5: Structured condition predicates
Rule matching uses a full LLM call because conditions are free-text. Structured condition fields (object count range, color set size, grid aspect ratio, transformation category tag) would allow fast programmatic pre-filtering before the LLM pass. This reduces matching cost and false positives on large rule bases.

---

## Quick reference: failure types and their signals

| Signal observed | Likely failure type | First thing to check |
|---|---|---|
| MEDIATOR produces 0 steps | Rule conflict or no matching tool | Check rules.json for conflicting active rules on same task |
| Solver hypothesis is partially right but misses a key property | Solver reasoning gap | Which reasoning step is missing from solver.md? |
| Tool generator fails all fix attempts | Algorithm too complex for one tool | Does the algorithm decompose into 2+ sub-algorithms? If so, build a builtin |
| Correct in demos, wrong on test | Overfitting to demo-specific constants | Check if tool/rule hardcodes colors, sizes, or coordinates from demos |
| Preference rule extracts wrong lesson | Correction event timing issue | Were `failed_hypotheses.json` entries available? Did solver already have the right hypothesis in Round 1? |
| Retry runs accumulate conflicting rules | Rule base maintenance gap | Run `auto_deprecate()`, review rules for same-task conflicts |
| Rule fires but never succeeds | Condition too broad or action wrong | Review condition vs actual task pattern; check if action tool is correct |
