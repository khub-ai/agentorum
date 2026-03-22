"""
agents.py — Async Anthropic API calls for each ensemble agent.

Loads system prompts from the prompts/ directory next to this package,
injects prior knowledge and task context, and returns structured responses.
"""

from __future__ import annotations
import asyncio
import os
import time
from pathlib import Path
from typing import Optional

import anthropic

from grid_tools import Grid, grid_to_str, summarize
from metadata import (
    SolverEntry, CriticVerdict, MediatorDecision,
    extract_solver_fields, extract_critic_verdicts, extract_json_grid,
)

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

PROMPTS_DIR = Path(__file__).parent.parent / "prompts"

PROMPT_FILES = {
    "SOLVER-SPATIAL":     PROMPTS_DIR / "solver-spatial.md",
    "SOLVER-PROCEDURAL":  PROMPTS_DIR / "solver-procedural.md",
    "SOLVER-ANALOGICAL":  PROMPTS_DIR / "solver-analogical.md",
    "CRITIC":             PROMPTS_DIR / "critic.md",
    "MEDIATOR":           PROMPTS_DIR / "mediator.md",
}

_prompt_cache: dict[str, str] = {}

def load_prompt(agent_id: str) -> str:
    if agent_id not in _prompt_cache:
        path = PROMPT_FILES[agent_id]
        _prompt_cache[agent_id] = path.read_text(encoding="utf-8")
    return _prompt_cache[agent_id]


# ---------------------------------------------------------------------------
# Anthropic client (lazy singleton)
# ---------------------------------------------------------------------------

_client: Optional[anthropic.AsyncAnthropic] = None

def get_client() -> anthropic.AsyncAnthropic:
    global _client
    if _client is None:
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            raise RuntimeError("ANTHROPIC_API_KEY environment variable not set")
        _client = anthropic.AsyncAnthropic(api_key=api_key)
    return _client


# ---------------------------------------------------------------------------
# Task formatting
# ---------------------------------------------------------------------------

def format_task_for_prompt(task: dict) -> str:
    """Render a task's train/test pairs as readable text for injection into prompts."""
    lines = ["## Task\n"]
    for i, pair in enumerate(task.get("train", []), 1):
        lines.append(f"### Demo pair {i}")
        lines.append("**Input:**")
        lines.append(grid_to_str(pair["input"]))
        lines.append("**Output:**")
        lines.append(grid_to_str(pair["output"]))
        lines.append(f"*Shape: {summarize(pair['input'])} → {summarize(pair['output'])}*\n")
    for i, t in enumerate(task.get("test", []), 1):
        lines.append(f"### Test input {i}")
        lines.append(grid_to_str(t["input"]))
        lines.append(f"*Shape: {summarize(t['input'])}*\n")
    return "\n".join(lines)

def format_debate_for_prompt(debate: list[dict]) -> str:
    """Render a debate log as text for injection into subsequent rounds."""
    if not debate:
        return "(no prior debate)"
    lines = ["## Prior debate\n"]
    for entry in debate:
        lines.append(f"### Round {entry['round']} — {entry['agent']}")
        lines.append(entry["content"])
        lines.append("")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Core call
# ---------------------------------------------------------------------------

DEFAULT_MODEL = "claude-sonnet-4-20250514"
DEFAULT_MAX_TOKENS = 4096

async def call_agent(
    agent_id: str,
    user_message: str,
    model: str = DEFAULT_MODEL,
    max_tokens: int = DEFAULT_MAX_TOKENS,
) -> tuple[str, int]:
    """
    Call an agent with its system prompt + a user message.
    Returns (response_text, duration_ms).
    """
    system_prompt = load_prompt(agent_id)
    client = get_client()
    t0 = time.time()
    response = await client.messages.create(
        model=model,
        max_tokens=max_tokens,
        system=system_prompt,
        messages=[{"role": "user", "content": user_message}],
    )
    duration_ms = int((time.time() - t0) * 1000)
    text = response.content[0].text if response.content else ""
    return text, duration_ms


# ---------------------------------------------------------------------------
# Round 1 — Solver initial proposals (parallel)
# ---------------------------------------------------------------------------

async def run_solvers_round1(
    task: dict,
    prior_knowledge: str = "",
) -> list[SolverEntry]:
    """Run all three solvers in parallel for Round 1."""
    task_text = format_task_for_prompt(task)
    knowledge_section = (
        f"\n## Prior Knowledge\n{prior_knowledge}\n" if prior_knowledge.strip() else ""
    )
    user_msg = f"{knowledge_section}\n{task_text}\n\nPlease propose your solution."

    async def run_one(agent_id: str, round_num: int) -> SolverEntry:
        text, ms = await call_agent(agent_id, user_msg)
        grid, rule, confidence = extract_solver_fields(text)
        return SolverEntry(
            agent=agent_id,
            round=round_num,
            rule=rule,
            confidence=confidence,
            grid=grid,
            raw_response=text,
            duration_ms=ms,
        )

    results = await asyncio.gather(
        run_one("SOLVER-SPATIAL", 1),
        run_one("SOLVER-PROCEDURAL", 1),
        run_one("SOLVER-ANALOGICAL", 1),
    )
    return list(results)


# ---------------------------------------------------------------------------
# Round 2 — CRITIC verification
# ---------------------------------------------------------------------------

async def run_critic(
    task: dict,
    solver_entries: list[SolverEntry],
) -> CriticVerdict:
    """Ask the CRITIC to evaluate each solver's proposal against all demo pairs."""
    task_text = format_task_for_prompt(task)

    proposals = []
    for e in solver_entries:
        grid_str = grid_to_str(e.grid) if e.grid else "(no grid produced)"
        proposals.append(
            f"### {e.agent} (confidence: {e.confidence})\n"
            f"Rule: {e.rule}\n"
            f"Proposed output:\n{grid_str}"
        )

    user_msg = (
        f"{task_text}\n\n"
        "## Solver proposals\n\n"
        + "\n\n".join(proposals)
        + "\n\nPlease evaluate each proposal against every demo pair."
    )

    text, ms = await call_agent("CRITIC", user_msg)
    verdicts = extract_critic_verdicts(text)

    return CriticVerdict(
        round=2,
        verdicts=verdicts,
        notes=text[:500],
        raw_response=text,
        duration_ms=ms,
    )


# ---------------------------------------------------------------------------
# Round 3 — Solver revisions (parallel)
# ---------------------------------------------------------------------------

async def run_solvers_round3(
    task: dict,
    r1_entries: list[SolverEntry],
    critic_verdict: CriticVerdict,
    prior_knowledge: str = "",
    human_insight: str = "",
) -> list[SolverEntry]:
    """Run all three solvers in parallel for Round 3, with CRITIC feedback."""
    task_text = format_task_for_prompt(task)

    # Build the shared context (seen by all solvers)
    peer_proposals = []
    for e in r1_entries:
        grid_str = grid_to_str(e.grid) if e.grid else "(no grid)"
        peer_proposals.append(
            f"**{e.agent}** (Round 1, {e.confidence} confidence)\n"
            f"Rule: {e.rule}\nGrid:\n{grid_str}"
        )

    critic_block = (
        "## CRITIC feedback\n" + critic_verdict.raw_response[:1500]
    )

    knowledge_section = (
        f"\n## Prior Knowledge\n{prior_knowledge}\n" if prior_knowledge.strip() else ""
    )
    human_section = (
        f"\n## Human Insight\n{human_insight}\n" if human_insight.strip() else ""
    )

    shared_context = (
        f"{knowledge_section}{human_section}"
        f"{task_text}\n\n"
        "## Round 1 proposals from all solvers\n\n"
        + "\n\n".join(peer_proposals)
        + f"\n\n{critic_block}\n\n"
        "Please revise your solution based on the CRITIC's feedback and your peers' proposals."
    )

    async def run_one(agent_id: str) -> SolverEntry:
        text, ms = await call_agent(agent_id, shared_context)
        grid, rule, confidence = extract_solver_fields(text)
        return SolverEntry(
            agent=agent_id,
            round=3,
            rule=rule,
            confidence=confidence,
            grid=grid,
            raw_response=text,
            duration_ms=ms,
        )

    results = await asyncio.gather(
        run_one("SOLVER-SPATIAL"),
        run_one("SOLVER-PROCEDURAL"),
        run_one("SOLVER-ANALOGICAL"),
    )
    return list(results)


# ---------------------------------------------------------------------------
# Round 4 — MEDIATOR final decision
# ---------------------------------------------------------------------------

async def run_mediator(
    task: dict,
    r1_entries: list[SolverEntry],
    critic_verdict: CriticVerdict,
    r3_entries: list[SolverEntry],
    prior_knowledge: str = "",
    converged_early: bool = False,
) -> MediatorDecision:
    """Ask MEDIATOR to pick the best answer and extract knowledge."""
    task_text = format_task_for_prompt(task)

    def fmt_entries(entries: list[SolverEntry], label: str) -> str:
        parts = [f"## {label}"]
        for e in entries:
            grid_str = grid_to_str(e.grid) if e.grid else "(none)"
            parts.append(
                f"### {e.agent} ({e.confidence})\nRule: {e.rule}\nGrid:\n{grid_str}"
            )
        return "\n".join(parts)

    knowledge_section = (
        f"\n## Prior Knowledge\n{prior_knowledge}\n" if prior_knowledge.strip() else ""
    )
    convergence_note = (
        "\n**Note:** All solvers converged in Round 1 and CRITIC confirmed. "
        "Rounds 3 was skipped.\n"
        if converged_early else ""
    )

    user_msg = (
        f"{knowledge_section}"
        f"{task_text}\n\n"
        f"{convergence_note}"
        f"{fmt_entries(r1_entries, 'Round 1 proposals')}\n\n"
        f"## CRITIC verdict (Round 2)\n{critic_verdict.raw_response[:1500]}\n\n"
        + (f"{fmt_entries(r3_entries, 'Round 3 revised proposals')}\n\n" if r3_entries else "")
        + "Please produce the final answer and extract knowledge for future tasks."
    )

    text, ms = await call_agent("MEDIATOR", user_msg)
    grid = extract_json_grid(text)

    return MediatorDecision(
        round=4 if not converged_early else 3,
        answer=grid,
        rationale=text[:800],
        converged=converged_early,
        raw_response=text,
        duration_ms=ms,
    )
