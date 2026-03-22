"""
ensemble.py — Main orchestrator for the ARC-AGI debate ensemble.

Implements the 4-round debate protocol with convergence shortcut,
rule-based knowledge injection, human-in-the-loop, and metadata capture.

Protocol:
  Round 0:  Rule matching — evaluate active rules against puzzle (one LLM call)
  Round 1:  Three solvers propose in parallel (with matched rules injected)
            → convergence check: if all agree + CRITIC confirms → skip R3
  Round 2:  CRITIC evaluates all proposals
  Round 3:  Solvers revise in parallel (skipped if early convergence)
  Round 4:  MEDIATOR produces final answer + proposes rule updates
"""

from __future__ import annotations
import asyncio
import time
from typing import Optional

from grid_tools import Grid, grids_equal, grid_to_str, summarize
from metadata import (
    TaskMetadata, SolverEntry, compute_outcome,
    print_task_summary,
)
from agents import (
    run_solvers_round1, run_critic, run_solvers_round3, run_mediator,
    call_agent, format_task_for_prompt, DEFAULT_MODEL,
)
from rules import RuleEngine, RuleMatch, FiringResult
import display as disp


# ---------------------------------------------------------------------------
# Convergence check
# ---------------------------------------------------------------------------

def _all_converged(entries: list[SolverEntry]) -> bool:
    """True if all three solvers produced identical non-None grids."""
    grids = [e.grid for e in entries if e.grid is not None]
    if len(grids) < len(entries):
        return False
    ref = grids[0]
    return all(grids_equal(ref, g) for g in grids[1:])


# ---------------------------------------------------------------------------
# Rule matching (Round 0)
# ---------------------------------------------------------------------------

async def _match_rules(
    rule_engine: RuleEngine,
    task: dict,
) -> list[RuleMatch]:
    """
    One cheap LLM call to evaluate which rules' conditions match this puzzle.
    Returns ranked list of matches.
    """
    if not rule_engine.active_rules():
        return []

    task_text = format_task_for_prompt(task)
    user_msg = rule_engine.build_match_prompt(task_text)

    # Use a small/fast model for matching — it's a classification task
    text, _ms = await call_agent.__wrapped__(
        agent_id="MEDIATOR",  # reuse MEDIATOR's system prompt for context
        user_message=user_msg,
        max_tokens=1024,
    ) if hasattr(call_agent, '__wrapped__') else (
        # Direct call if no wrapper
        await _match_rules_direct(rule_engine, task_text)
    )

    return rule_engine.parse_match_response(text)


async def _match_rules_direct(
    rule_engine: RuleEngine,
    task_text: str,
) -> tuple[str, int]:
    """Direct rule matching call."""
    user_msg = rule_engine.build_match_prompt(task_text)
    text, ms = await call_agent("MEDIATOR", user_msg, max_tokens=1024)
    return text, ms


async def match_rules(
    rule_engine: RuleEngine,
    task: dict,
) -> list[RuleMatch]:
    """
    Evaluate which rules match this puzzle. Returns ranked matches.
    """
    if not rule_engine.active_rules():
        return []

    task_text = format_task_for_prompt(task)
    user_msg = rule_engine.build_match_prompt(task_text)
    text, _ms = await call_agent("MEDIATOR", user_msg, max_tokens=1024)
    return rule_engine.parse_match_response(text)


# ---------------------------------------------------------------------------
# Human-in-the-loop
# ---------------------------------------------------------------------------

def _detect_stalemate(
    r1_entries: list[SolverEntry],
    r3_entries: list[SolverEntry],
) -> bool:
    """
    True if Round 3 solvers didn't converge AND didn't improve meaningfully
    over Round 1 (all still disagree).
    """
    if not r3_entries:
        return False
    return not _all_converged(r3_entries)


# ---------------------------------------------------------------------------
# Main orchestrator
# ---------------------------------------------------------------------------

async def run_ensemble(
    task: dict,
    task_id: str = "unknown",
    expected: Optional[Grid] = None,
    rule_engine: Optional[RuleEngine] = None,
    human_in_loop: bool = False,
    verbose: bool = True,
) -> TaskMetadata:
    """
    Run the full debate ensemble on a single ARC-AGI task.

    Args:
        task:          ARC task dict with 'train' and 'test' keys
        task_id:       Human-readable ID for logging
        expected:      Known solution (for evaluation; can be None)
        rule_engine:   RuleEngine instance (created if None)
        human_in_loop: If True, show rich checkpoints and prompt for input
        verbose:       Print progress output

    Returns:
        TaskMetadata with all intermediate results and outcome.
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
    log(f"Task: {task_id}  ({meta.train_pairs} demos, test {meta.test_shape[0]}×{meta.test_shape[1]})", force=True)
    log(f"Model: {DEFAULT_MODEL}  |  Rules: {rule_engine.stats_summary()}", force=True)

    # ------------------------------------------------------------------
    # Round 0 — Rule matching
    # ------------------------------------------------------------------
    log("Round 0: matching rules…", force=True)
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
    human_hypothesis = ""
    if human_in_loop:
        disp.show_puzzle(task, task_id, expected=expected)
        human_hypothesis = disp.human_hypothesis_checkpoint(task_id)
        if human_hypothesis:
            log(f"  Human hypothesis: {human_hypothesis[:80]}")

    # ------------------------------------------------------------------
    # Round 1 — Parallel solver proposals
    # ------------------------------------------------------------------
    log("Round 1: solvers proposing…", force=True)
    t_r1 = time.time()
    r1_entries = await run_solvers_round1(
        task,
        prior_knowledge=rules_prompt_section,
        human_hypothesis=human_hypothesis,
    )
    meta.solvers_r1 = r1_entries
    log(f"  Done in {time.time()-t_r1:.1f}s", force=True)
    for e in r1_entries:
        shape_str = summarize(e.grid) if e.grid else "(no grid)"
        log(f"  {e.agent}: {e.confidence}  rule={e.rule[:60]}  grid={shape_str}")

    if human_in_loop:
        disp.show_r1_proposals(r1_entries)

    # Convergence check
    early_converge = False
    if _all_converged(r1_entries):
        log("  → All solvers CONVERGED in Round 1, running CRITIC to confirm…", force=True)

    # ------------------------------------------------------------------
    # Round 2 — CRITIC
    # ------------------------------------------------------------------
    log("Round 2: CRITIC evaluating…", force=True)
    critic_verdict = await run_critic(task, r1_entries)
    meta.critic = critic_verdict
    log(f"  Verdicts: {critic_verdict.verdicts}", force=True)

    all_pass = all(v == "PASS" for v in critic_verdict.verdicts.values())

    human_r3_insight = ""
    if human_in_loop:
        disp.show_critic_results(r1_entries, critic_verdict, expected=expected)
        if not (all_pass and _all_converged(r1_entries)):
            human_r3_insight = disp.human_post_critic_checkpoint()
            if human_r3_insight:
                log(f"  Human R3 insight: {human_r3_insight[:80]}")

    if _all_converged(r1_entries) and all_pass:
        log("  → CRITIC confirmed convergence. Skipping Round 3.")
        early_converge = True
        r3_entries: list[SolverEntry] = []
    else:
        # ------------------------------------------------------------------
        # Round 3 — Solver revisions
        # ------------------------------------------------------------------
        log("Round 3: solvers revising…", force=True)
        t_r3 = time.time()

        r3_entries = await run_solvers_round3(
            task, r1_entries, critic_verdict,
            prior_knowledge=rules_prompt_section,
            human_insight=human_r3_insight,
        )
        meta.solvers_r3 = r3_entries
        log(f"  Done in {time.time()-t_r3:.1f}s", force=True)
        for e in r3_entries:
            shape_str = summarize(e.grid) if e.grid else "(no grid)"
            log(f"  {e.agent}: {e.confidence}  rule={e.rule[:60]}  grid={shape_str}")

    human_mediator_insight = ""
    if human_in_loop and r3_entries:
        disp.show_r3_proposals(r1_entries, r3_entries, critic_verdict, expected=expected)
        human_mediator_insight = disp.human_pre_mediator_checkpoint()
        if human_mediator_insight:
            log(f"  Human mediator insight: {human_mediator_insight[:80]}", force=True)

    # ------------------------------------------------------------------
    # Round 4 — MEDIATOR (with rule system section)
    # ------------------------------------------------------------------
    log(f"Round {'3 (early)' if early_converge else '4'}: MEDIATOR deciding…", force=True)

    # Build rule section for MEDIATOR (will be appended to its user message)
    # We pass success=None here; the actual success isn't known yet.
    # MEDIATOR gets rule context and decides on updates after seeing the full debate.
    mediator_rule_section = rule_engine.build_mediator_rule_section(
        matched_rules, success=True  # optimistic; we update stats after
    )

    mediator_result = await run_mediator(
        task=task,
        r1_entries=r1_entries,
        critic_verdict=critic_verdict,
        r3_entries=r3_entries,
        prior_knowledge=rules_prompt_section,
        converged_early=early_converge,
        human_insight=human_mediator_insight,
        rule_section=mediator_rule_section,
    )
    meta.mediator = mediator_result
    grid_str = summarize(mediator_result.answer) if mediator_result.answer else "(no grid)"
    log(f"  Answer: {grid_str}", force=True)

    # ------------------------------------------------------------------
    # Finalize metadata
    # ------------------------------------------------------------------
    meta.total_duration_ms = int(time.time() * 1000) - meta.start_ms
    meta.rounds_completed = 3 if early_converge else 4
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
    if mediator_result.raw_response:
        rule_changes = rule_engine.parse_mediator_rule_updates(
            mediator_result.raw_response, task_id
        )
        if rule_changes:
            log(f"  Rule updates: {len(rule_changes)} rule(s) created/modified", force=True)

    if verbose and not human_in_loop:
        print_task_summary(meta, expected)

    # Checkpoint 4 — Final result + rule changes
    if human_in_loop:
        disp.show_final_result(meta, expected)
        if rule_changes or matched_rules:
            disp.show_rule_updates(matched_rules, rule_changes, success, rule_engine)

    return meta


# ---------------------------------------------------------------------------
# Sync wrapper (for use from non-async code)
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
