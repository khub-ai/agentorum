"""
ensemble.py — Main orchestrator for the ARC-AGI debate ensemble.

New architecture: reasoning separated from execution.

Protocol:
  Round 0:  Rule matching — evaluate active rules against puzzle
  Round 1:  Solver(s) propose TEXT-ONLY hypotheses (parallel if multiple)
  Round 2:  MEDIATOR synthesizes hypotheses into pseudo-code
  Round 3:  EXECUTOR runs pseudo-code against all demo pairs (deterministic)
            if all pass -> apply to test input -> done
            if fail -> MEDIATOR revises (up to MAX_REVISIONS times)
  Final:    MEDIATOR updates rules based on outcome
"""

from __future__ import annotations
import asyncio
import time
from typing import Optional

from grid_tools import Grid, grids_equal, summarize
from metadata import TaskMetadata, SolverEntry, MediatorDecision, compute_outcome, print_task_summary
from agents import (
    run_solvers_round1, run_mediator_synthesize, run_mediator_revise,
    run_mediator_extract_preference,
    run_tool_generator, run_tool_generator_fix, call_agent,
    format_task_for_prompt, DEFAULT_MODEL, DEFAULT_SOLVERS,
    reset_cost_tracker, get_cost_tracker,
)
from executor import (
    run_executor, ExecutionResult, format_execution_trace, tool_signatures,
    parse_new_tools, register_dynamic_tool, test_tool_code,
)
from rules import RuleEngine, RuleMatch
from tools import ToolRegistry
import display as disp

MAX_REVISIONS = 5  # how many times MEDIATOR can revise pseudo-code after failure


_TOOL_FIX_ATTEMPTS = 3   # max self-correction retries per tool


async def _generate_and_register_tools(
    mediator_text: str,
    human_in_loop: bool,
    log_fn,
    task: dict | None = None,
    tool_registry: ToolRegistry | None = None,
) -> list[dict]:
    """
    Parse new tool requests from MEDIATOR response, generate Python code for each,
    verify against demo pairs, and self-correct up to _TOOL_FIX_ATTEMPTS times.

    If tool_registry is provided:
    - Cache hit: reloads code from registry, skipping generation entirely.
    - Cache miss: generates, verifies, then persists verified tools to registry.
    """
    specs = parse_new_tools(mediator_text)
    results = []

    for spec in specs:
        name = spec.get("name", "?")
        total_ms = 0
        final_success = False
        final_error = ""
        code = ""

        # ---- Registry cache check ----------------------------------------
        if tool_registry:
            cached = tool_registry.get(name)
            if cached:
                ok, err = register_dynamic_tool(name, cached["code"])
                log_fn(f"  [tool_creator] {name}: loaded from registry (task "
                       f"{cached.get('source_task', '?')})", force=True)
                results.append({
                    "name": name, "spec": spec, "code": cached["code"],
                    "success": ok, "error": err, "ms": 0,
                })
                if human_in_loop:
                    disp.show_tool_generation(spec, cached["code"], ok, err)
                continue

        # ---- Generate new tool -------------------------------------------
        log_fn(f"  [tool_creator] Generating tool: {name}...", force=True)
        code, gen_ms = await run_tool_generator(spec, task=task)
        total_ms = gen_ms
        fix_attempt = 0

        if task:
            all_pass, trace = test_tool_code(name, code, task)

            while not all_pass and fix_attempt < _TOOL_FIX_ATTEMPTS:
                fix_attempt += 1
                log_fn(f"  [tool_creator] {name}: demo verification failed, fixing "
                       f"(attempt {fix_attempt}/{_TOOL_FIX_ATTEMPTS})...", force=True)
                fixed_code, fix_ms = await run_tool_generator_fix(spec, code, trace, task=task)
                total_ms += fix_ms
                code = fixed_code
                all_pass, trace = test_tool_code(name, code, task)

            if all_pass:
                final_success = True
                log_fn(f"  [tool_creator] {name}: verified OK "
                       f"({'first try' if fix_attempt == 0 else f'{fix_attempt} fix(es)'})",
                       force=True)
            else:
                final_success, final_error = register_dynamic_tool(name, code)
                log_fn(f"  [tool_creator] {name}: FAILED verification after "
                       f"{_TOOL_FIX_ATTEMPTS} fix(es) — registered with last attempt",
                       force=True)
        else:
            final_success, final_error = register_dynamic_tool(name, code)
            log_fn(f"  [tool_creator] {name}: "
                   f"{'registered OK (no demo check)' if final_success else f'FAILED: {final_error}'}",
                   force=True)

        # ---- Persist to registry if verified ------------------------------
        if tool_registry and code:
            source_task = task.get("_task_id", "") if task else ""
            tool_registry.register(
                name=name,
                code=code,
                verified=final_success,
                source_task=source_task,
                description=spec.get("description", ""),
                fix_attempts=fix_attempt,
            )

        results.append({
            "name": name, "spec": spec, "code": code,
            "success": final_success, "error": final_error, "ms": total_ms,
        })
        if human_in_loop:
            disp.show_tool_generation(spec, code, final_success, final_error)

    return results


# ---------------------------------------------------------------------------
# Rule matching (Round 0)
# ---------------------------------------------------------------------------

async def match_rules(
    rule_engine: RuleEngine,
    task: dict,
) -> list[RuleMatch]:
    """Evaluate which rules match this puzzle. Returns ranked matches."""
    if not rule_engine.active_rules():
        return []
    task_text = format_task_for_prompt(task)
    user_msg = rule_engine.build_match_prompt(task_text)
    text, _ms = await call_agent("MEDIATOR", user_msg, max_tokens=1024)
    return rule_engine.parse_match_response(text)


# ---------------------------------------------------------------------------
# Main orchestrator
# ---------------------------------------------------------------------------

async def run_ensemble(
    task: dict,
    task_id: str = "unknown",
    expected: Optional[Grid] = None,
    rule_engine: Optional[RuleEngine] = None,
    tool_registry: Optional[ToolRegistry] = None,
    human_in_loop: bool = False,
    human_hypothesis: str = "",
    human_insight: str = "",
    human_revision_hint: str = "",
    verbose: bool = True,
    dataset: str = "",
    solver_ids: list[str] | None = None,
) -> TaskMetadata:
    """
    Run the full ensemble on a single ARC-AGI task.

    Flow: Rule match -> Solvers (text) -> MEDIATOR (pseudo-code) -> EXECUTOR -> revise loop
    """
    if rule_engine is None:
        rule_engine = RuleEngine()
    if tool_registry is None:
        tool_registry = ToolRegistry()

    # Tag task dict with its ID so _generate_and_register_tools can record it
    task["_task_id"] = task_id

    reset_cost_tracker()
    _tools_generated: list[str] = []
    _human_hints_used = bool(human_hypothesis or human_insight or human_revision_hint)

    test_input = task["test"][0]["input"] if task.get("test") else []
    exp_shape = (len(expected), len(expected[0])) if expected and expected[0] else None

    meta = TaskMetadata(
        task_id=task_id,
        train_pairs=len(task.get("train", [])),
        test_shape=(len(test_input), len(test_input[0]) if test_input else 0),
        expected_shape=exp_shape,
    )

    def log(msg: str, force: bool = False) -> None:
        if verbose and (force or not human_in_loop):
            print(msg)

    log(f"\n{'-'*50}", force=True)
    log(f"Task: {task_id}  ({meta.train_pairs} demos, test {meta.test_shape[0]}x{meta.test_shape[1]})", force=True)
    log(f"Model: {DEFAULT_MODEL}  |  Rules: {rule_engine.stats_summary()}", force=True)

    # ------------------------------------------------------------------
    # Round 0 — Rule matching
    # ------------------------------------------------------------------
    log("Round 0: matching rules...", force=True)
    matched_rules = await match_rules(rule_engine, task)
    fired_ids = [m.rule_id for m in matched_rules]

    if matched_rules:
        log(f"  Matched {len(matched_rules)} rule(s): {fired_ids}", force=True)
    else:
        log("  No rules matched.", force=True)

    rules_prompt_section = rule_engine.format_fired_rules_for_prompt(matched_rules)
    preference_priors_section = rule_engine.format_preference_rules_for_solver()

    if human_in_loop:
        disp.show_rule_matches(matched_rules, rule_engine)

    # ------------------------------------------------------------------
    # Checkpoint 0 — Show puzzle, ask for human hypothesis
    # ------------------------------------------------------------------
    if human_in_loop:
        disp.show_puzzle(task, task_id, expected=expected)
        human_hypothesis = disp.human_hypothesis_checkpoint(task_id, prefill=human_hypothesis)
        if human_hypothesis:
            log(f"  Human hypothesis: {human_hypothesis[:80]}")

    # ------------------------------------------------------------------
    # Round 1 — Parallel solver hypotheses (TEXT ONLY)
    # ------------------------------------------------------------------
    log("Round 1: solvers proposing hypotheses...", force=True)
    t_r1 = time.time()
    r1_entries = await run_solvers_round1(
        task,
        prior_knowledge=rules_prompt_section,
        human_hypothesis=human_hypothesis,
        solver_ids=solver_ids,
        preference_priors=preference_priors_section,
    )
    meta.solvers_r1 = r1_entries
    log(f"  Done in {time.time()-t_r1:.1f}s", force=True)
    for e in r1_entries:
        log(f"  {e.agent}: {e.confidence}  rule={e.rule[:80]}")

    if human_in_loop:
        disp.show_r1_hypotheses(r1_entries)

    # ------------------------------------------------------------------
    # Round 2 — MEDIATOR synthesizes pseudo-code
    # ------------------------------------------------------------------
    human_r2_insight = human_insight  # use CLI --insight even without --human
    if human_in_loop:
        human_r2_insight = disp.human_post_hypotheses_checkpoint(prefill=human_insight)

    log("Round 2: MEDIATOR synthesizing pseudo-code...", force=True)
    t_r2 = time.time()

    rule_section = rule_engine.build_mediator_rule_section(matched_rules, success=True)
    tool_section = tool_registry.build_tool_section_for_prompt()

    mediator_text, pseudocode, mediator_ms = await run_mediator_synthesize(
        task=task,
        solver_entries=r1_entries,
        prior_knowledge=rules_prompt_section,
        human_insight=human_r2_insight or human_hypothesis,
        rule_section=rule_section,
        tool_section=tool_section,
    )
    log(f"  Done in {time.time()-t_r2:.1f}s  |  {len(pseudocode)} steps", force=True)
    for s in pseudocode:
        log(f"    Step {s.get('step', '?')}: {s.get('tool', '?')}({s.get('args', {})})")

    for r in await _generate_and_register_tools(
        mediator_text, human_in_loop, log, task=task, tool_registry=tool_registry
    ):
        if r["success"]:
            _tools_generated.append(r["name"])

    if human_in_loop:
        disp.show_pseudocode(pseudocode, mediator_text)

    # ------------------------------------------------------------------
    # Round 3 — EXECUTOR runs pseudo-code (deterministic)
    # ------------------------------------------------------------------
    log("Round 3: EXECUTOR running pseudo-code against demos...", force=True)

    exec_result: ExecutionResult = run_executor(pseudocode, task)
    attempt = 1

    if human_in_loop:
        disp.show_execution_result(exec_result, expected=expected)

    # ------------------------------------------------------------------
    # Revision loop — MEDIATOR revises on failure
    # ------------------------------------------------------------------
    while not exec_result.all_pass and attempt <= MAX_REVISIONS:
        log(f"  FAILED on {sum(1 for d in exec_result.demos if not d.passed)} demo(s). "
            f"Revision {attempt}/{MAX_REVISIONS}...", force=True)

        trace_text = format_execution_trace(exec_result)

        human_revision_insight = human_revision_hint  # use CLI --revision-hint even without --human
        if human_in_loop:
            human_revision_insight = disp.human_revision_checkpoint(attempt, prefill=human_revision_hint)

        mediator_text, pseudocode, rev_ms = await run_mediator_revise(
            task=task,
            solver_entries=r1_entries,
            previous_pseudocode=pseudocode,
            execution_trace=trace_text,
            human_insight=human_revision_insight,
        )
        mediator_ms += rev_ms
        log(f"  Revised: {len(pseudocode)} steps", force=True)

        for r in await _generate_and_register_tools(
            mediator_text, human_in_loop, log, task=task, tool_registry=tool_registry
        ):
            if r["success"]:
                _tools_generated.append(r["name"])

        if human_in_loop:
            disp.show_pseudocode(pseudocode, mediator_text, revision=attempt)

        exec_result = run_executor(pseudocode, task)
        attempt += 1

        if human_in_loop:
            disp.show_execution_result(exec_result, expected=expected)

    # ------------------------------------------------------------------
    # Build final metadata
    # ------------------------------------------------------------------
    final_answer = exec_result.test_output
    total_rounds = 2 + attempt  # R0 + R1 + R2 + executor attempts

    meta.mediator = MediatorDecision(
        round=total_rounds,
        answer=final_answer,
        rationale=mediator_text[:800] if mediator_text else "",
        converged=exec_result.all_pass,
        raw_response=mediator_text or "",
        duration_ms=mediator_ms,
    )
    meta.total_duration_ms = int(time.time() * 1000) - meta.start_ms
    meta.rounds_completed = total_rounds
    compute_outcome(meta, expected)

    # Leaderboard stats
    ct = get_cost_tracker()
    meta.model            = DEFAULT_MODEL
    meta.dataset          = dataset
    meta.human_hints_used = _human_hints_used
    meta.tools_generated  = list(dict.fromkeys(_tools_generated))  # deduplicated
    meta.input_tokens          = ct.input_tokens
    meta.cache_creation_tokens = ct.cache_creation_tokens
    meta.cache_read_tokens     = ct.cache_read_tokens
    meta.output_tokens         = ct.output_tokens
    meta.api_calls             = ct.api_calls
    meta.cost_usd              = round(ct.cost_usd(), 6)

    success = meta.correct or False

    # ------------------------------------------------------------------
    # Update rule stats
    # ------------------------------------------------------------------
    for m in matched_rules:
        if success:
            rule_engine.record_success(m.rule_id, task_id)
        else:
            rule_engine.record_failure(m.rule_id, task_id)

    # ------------------------------------------------------------------
    # Parse MEDIATOR rule updates
    # ------------------------------------------------------------------
    rule_changes: list[dict] = []
    if mediator_text:
        rule_changes = rule_engine.parse_mediator_rule_updates(mediator_text, task_id)
        if rule_changes:
            log(f"  Rule updates: {len(rule_changes)} rule(s) created/modified", force=True)

    # ------------------------------------------------------------------
    # Preference rule extraction — fires when a human insight corrected
    # a wrong hypothesis and the corrected approach succeeded.
    #
    # This is a (wrong_hypothesis → correction → success) training event.
    # MEDIATOR distills it into a preference rule: a soft prior about
    # *which hypothesis property to prefer* when evidence is ambiguous.
    # The preference does not hard-code the answer — it biases the solver
    # toward human-natural reasoning properties (topology, perceptual
    # grouping, relative position) over computationally-easy but
    # non-human-natural ones (exact cell count, bounding box area).
    # ------------------------------------------------------------------
    if success and human_insight:
        log("  Correction event detected: extracting preference rule...", force=True)
        wrong_hyps = [e.rule[:300] for e in r1_entries]
        correct_approach = (mediator_text or "")[:600]
        existing_prefs = rule_engine.format_preference_rules_for_solver()
        pref_text = await run_mediator_extract_preference(
            task_id=task_id,
            wrong_hypotheses=wrong_hyps,
            human_insight=human_insight,
            correct_approach=correct_approach,
            existing_preference_rules=existing_prefs,
        )
        pref_changes = rule_engine.parse_mediator_rule_updates(pref_text, task_id)
        if pref_changes:
            pref_ids = [r["id"] for r in pref_changes]
            log(f"  Preference rules created: {pref_ids}", force=True)
            rule_changes.extend(pref_changes)

    # Auto-deprecate consistently failing rules
    deprecated = rule_engine.auto_deprecate()
    if deprecated:
        log(f"  Auto-deprecated {len(deprecated)} rule(s): {deprecated}", force=True)

    if verbose and not human_in_loop:
        print_task_summary(meta, expected)

    # Final display
    if human_in_loop:
        disp.show_final_result(meta, expected)
        if rule_changes or matched_rules:
            disp.show_rule_updates(matched_rules, rule_changes, success, rule_engine)

    return meta


# ---------------------------------------------------------------------------
# Sync wrapper
# ---------------------------------------------------------------------------

def run_ensemble_sync(
    task: dict,
    task_id: str = "unknown",
    expected: Optional[Grid] = None,
    rule_engine: Optional[RuleEngine] = None,
    human_in_loop: bool = False,
    verbose: bool = True,
) -> TaskMetadata:
    return asyncio.run(run_ensemble(
        task=task,
        task_id=task_id,
        expected=expected,
        rule_engine=rule_engine,
        human_in_loop=human_in_loop,
        verbose=verbose,
    ))
