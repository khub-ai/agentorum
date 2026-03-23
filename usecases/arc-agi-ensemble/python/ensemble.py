"""
ensemble.py — Main orchestrator for the ARC-AGI debate ensemble.

New architecture: reasoning separated from execution.

Protocol:
  Round 0:  Rule matching — evaluate active rules against puzzle
  Round 1:  Three solvers propose TEXT-ONLY hypotheses (parallel)
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
    run_tool_generator, call_agent, format_task_for_prompt, DEFAULT_MODEL,
)
from executor import (
    run_executor, ExecutionResult, format_execution_trace, tool_signatures,
    parse_new_tools, register_dynamic_tool,
)
from rules import RuleEngine, RuleMatch
import display as disp

MAX_REVISIONS = 5  # how many times MEDIATOR can revise pseudo-code after failure


async def _generate_and_register_tools(
    mediator_text: str,
    human_in_loop: bool,
    log_fn,
) -> list[dict]:
    """
    Parse new tool requests from MEDIATOR response, generate Python code for each,
    register them in the executor, and return a list of results for display.
    """
    specs = parse_new_tools(mediator_text)
    results = []
    for spec in specs:
        name = spec.get("name", "?")
        log_fn(f"  [tool_creator] Generating tool: {name}...", force=True)
        code, gen_ms = await run_tool_generator(spec)
        success, error = register_dynamic_tool(name, code)
        log_fn(f"  [tool_creator] {name}: {'registered OK' if success else f'FAILED: {error}'}", force=True)
        results.append({"spec": spec, "code": code, "success": success, "error": error, "ms": gen_ms})
        if human_in_loop:
            disp.show_tool_generation(spec, code, success, error)
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
    human_in_loop: bool = False,
    human_hypothesis: str = "",
    human_insight: str = "",
    human_revision_hint: str = "",
    verbose: bool = True,
) -> TaskMetadata:
    """
    Run the full ensemble on a single ARC-AGI task.

    Flow: Rule match -> Solvers (text) -> MEDIATOR (pseudo-code) -> EXECUTOR -> revise loop
    """
    if rule_engine is None:
        rule_engine = RuleEngine()

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
    human_r2_insight = ""
    if human_in_loop:
        human_r2_insight = disp.human_post_hypotheses_checkpoint(prefill=human_insight)

    log("Round 2: MEDIATOR synthesizing pseudo-code...", force=True)
    t_r2 = time.time()

    rule_section = rule_engine.build_mediator_rule_section(matched_rules, success=True)

    mediator_text, pseudocode, mediator_ms = await run_mediator_synthesize(
        task=task,
        solver_entries=r1_entries,
        prior_knowledge=rules_prompt_section,
        human_insight=human_r2_insight or human_hypothesis,
        rule_section=rule_section,
    )
    log(f"  Done in {time.time()-t_r2:.1f}s  |  {len(pseudocode)} steps", force=True)
    for s in pseudocode:
        log(f"    Step {s.get('step', '?')}: {s.get('tool', '?')}({s.get('args', {})})")

    await _generate_and_register_tools(mediator_text, human_in_loop, log)

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

        human_revision_insight = ""
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

        await _generate_and_register_tools(mediator_text, human_in_loop, log)

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
