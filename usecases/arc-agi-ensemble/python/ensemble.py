"""
ensemble.py — Main orchestrator for the ARC-AGI debate ensemble.

Implements the 4-round debate protocol with convergence shortcut,
human-in-the-loop injection, and metadata capture.

Protocol:
  Round 1:  Three solvers propose in parallel
            → convergence check: if all agree + CRITIC confirms → skip R3
  Round 2:  CRITIC evaluates all proposals
  Round 3:  Solvers revise in parallel (skipped if early convergence)
  Round 4:  MEDIATOR produces final answer + extracts knowledge
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
    DEFAULT_MODEL,
)
from knowledge import KnowledgeBase
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
    # If still no consensus after R3, it's a stalemate
    return not _all_converged(r3_entries)

def _prompt_human(task_id: str, r1_entries: list[SolverEntry],
                   r3_entries: list[SolverEntry]) -> str:
    """
    Interactive CLI prompt for human insight injection.
    Returns an insight string (empty string = no insight).
    """
    try:
        print("\n" + "═" * 60)
        print(f"STALEMATE detected on task {task_id}")
        print("Solvers have not converged after 2 rounds.")
        print("\nRound 1 proposals:")
        for e in r1_entries:
            print(f"  {e.agent}: {e.rule[:80]}")
        print("\nRound 3 proposals:")
        for e in r3_entries:
            print(f"  {e.agent}: {e.rule[:80]}")
        print("\nYou may enter a hint/insight to inject into the final round.")
        print("(Press Enter with no input to skip human intervention)\n")
        insight = input("Human insight > ").strip()
        print("═" * 60 + "\n")
        return insight
    except (EOFError, KeyboardInterrupt):
        return ""


# ---------------------------------------------------------------------------
# Main orchestrator
# ---------------------------------------------------------------------------

async def run_ensemble(
    task: dict,
    task_id: str = "unknown",
    expected: Optional[Grid] = None,
    knowledge_base: Optional[KnowledgeBase] = None,
    human_in_loop: bool = False,
    verbose: bool = True,
) -> TaskMetadata:
    """
    Run the full 4-round debate ensemble on a single ARC-AGI task.

    Args:
        task:           ARC task dict with 'train' and 'test' keys
        task_id:        Human-readable ID for logging
        expected:       Known solution (for evaluation; can be None)
        knowledge_base: KnowledgeBase instance (created if None)
        human_in_loop:  If True, prompt for human insight on stalemate
        verbose:        Print rich progress output

    Returns:
        TaskMetadata with all intermediate results and outcome.
    """
    if knowledge_base is None:
        knowledge_base = KnowledgeBase()

    test_input = task["test"][0]["input"] if task.get("test") else []
    exp_shape = (len(expected), len(expected[0])) if expected and expected[0] else None

    meta = TaskMetadata(
        task_id=task_id,
        train_pairs=len(task.get("train", [])),
        test_shape=(len(test_input), len(test_input[0]) if test_input else 0),
        expected_shape=exp_shape,
    )

    prior_knowledge = knowledge_base.format_for_prompt()

    def log(msg: str, force: bool = False) -> None:
        # In human mode the display panels already show per-round detail;
        # suppress noisy per-entry text logs unless forced.
        if verbose and (force or not human_in_loop):
            print(msg)

    log(f"\n{'─'*50}", force=True)
    log(f"Task: {task_id}  ({meta.train_pairs} demos, test {meta.test_shape[0]}×{meta.test_shape[1]})", force=True)
    log(f"Model: {DEFAULT_MODEL}  |  Prior KB: {knowledge_base.stats()}", force=True)

    # ------------------------------------------------------------------
    # Checkpoint 0 — Show puzzle, ask for human hypothesis
    # ------------------------------------------------------------------
    human_hypothesis = ""
    if human_in_loop:
        disp.show_puzzle(task, task_id)
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
        prior_knowledge=prior_knowledge,
        human_hypothesis=human_hypothesis,
    )
    meta.solvers_r1 = r1_entries
    log(f"  Done in {time.time()-t_r1:.1f}s", force=True)
    for e in r1_entries:
        shape_str = summarize(e.grid) if e.grid else "(no grid)"
        log(f"  {e.agent}: {e.confidence}  rule={e.rule[:60]}  grid={shape_str}")

    # Checkpoint 1 — Show R1 proposals
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

    # Checkpoint 2 — Show CRITIC results, ask for insight
    human_r3_insight = ""
    if human_in_loop:
        disp.show_critic_results(r1_entries, critic_verdict)
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
            prior_knowledge=prior_knowledge,
            human_insight=human_r3_insight,
        )
        meta.solvers_r3 = r3_entries
        log(f"  Done in {time.time()-t_r3:.1f}s", force=True)
        for e in r3_entries:
            shape_str = summarize(e.grid) if e.grid else "(no grid)"
            log(f"  {e.agent}: {e.confidence}  rule={e.rule[:60]}  grid={shape_str}")

    # Checkpoint 3 — Show R3 proposals, ask for final insight
    human_mediator_insight = ""
    if human_in_loop and r3_entries:
        disp.show_r3_proposals(r1_entries, r3_entries, critic_verdict)
        human_mediator_insight = disp.human_pre_mediator_checkpoint()
        if human_mediator_insight:
            log(f"  Human mediator insight: {human_mediator_insight[:80]}", force=True)
            knowledge_base.add_human_insight(human_mediator_insight, tasks=[task_id])

    # ------------------------------------------------------------------
    # Round 4 — MEDIATOR
    # ------------------------------------------------------------------
    log(f"Round {'3 (early)' if early_converge else '4'}: MEDIATOR deciding…", force=True)
    mediator_result = await run_mediator(
        task=task,
        r1_entries=r1_entries,
        critic_verdict=critic_verdict,
        r3_entries=r3_entries,
        prior_knowledge=prior_knowledge,
        converged_early=early_converge,
        human_insight=human_mediator_insight,
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

    # Update knowledge base from MEDIATOR output
    if mediator_result.raw_response:
        kb_counts = knowledge_base.parse_mediator_update(
            mediator_result.raw_response, task_id
        )
        mediator_result.kb_updates = kb_counts
        if any(kb_counts.values()):
            log(f"  KB updated: {kb_counts}", force=True)

    if verbose and not human_in_loop:
        print_task_summary(meta, expected)

    # Checkpoint 4 — Final result
    if human_in_loop:
        disp.show_final_result(meta, expected)

    return meta


# ---------------------------------------------------------------------------
# Sync wrapper (for use from non-async code)
# ---------------------------------------------------------------------------

def run_ensemble_sync(
    task: dict,
    task_id: str = "unknown",
    expected: Optional[Grid] = None,
    knowledge_base: Optional[KnowledgeBase] = None,
    human_in_loop: bool = False,
    verbose: bool = True,
) -> TaskMetadata:
    return asyncio.run(run_ensemble(
        task=task,
        task_id=task_id,
        expected=expected,
        knowledge_base=knowledge_base,
        human_in_loop=human_in_loop,
        verbose=verbose,
    ))
