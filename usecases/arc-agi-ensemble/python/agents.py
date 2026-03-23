"""
agents.py — Async Anthropic API calls for each ensemble agent.

Loads system prompts from the prompts/ directory next to this package,
injects prior knowledge and task context, and returns structured responses.
"""

from __future__ import annotations
import asyncio
import json
import os
import re
import time
from pathlib import Path
from typing import Optional

import anthropic

from grid_tools import Grid, grid_to_str, summarize
from metadata import SolverEntry, MediatorDecision, extract_json_grid

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

PROMPTS_DIR = Path(__file__).parent.parent / "prompts"

PROMPT_FILES = {
    "SOLVER-SPATIAL":     PROMPTS_DIR / "solver-spatial.md",
    "SOLVER-PROCEDURAL":  PROMPTS_DIR / "solver-procedural.md",
    "SOLVER-ANALOGICAL":  PROMPTS_DIR / "solver-analogical.md",
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
        lines.append(f"*Shape: {summarize(pair['input'])} -> {summarize(pair['output'])}*\n")
    for i, t in enumerate(task.get("test", []), 1):
        lines.append(f"### Test input {i}")
        lines.append(grid_to_str(t["input"]))
        inp = t["input"]
        lines.append(f"*Shape: {summarize(inp)}*\n")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Core call
# ---------------------------------------------------------------------------

DEFAULT_MODEL = "claude-sonnet-4-6"
DEFAULT_MAX_TOKENS = 4096

# Set to True by harness/ensemble to print prompts before each call
SHOW_PROMPTS: bool = False


async def call_agent(
    agent_id: str,
    user_message: str,
    model: str = DEFAULT_MODEL,
    max_tokens: int = DEFAULT_MAX_TOKENS,
    max_retries: int = 5,
) -> tuple[str, int]:
    """
    Call an agent with its system prompt + a user message.
    Returns (response_text, duration_ms).
    Retries on 529 overloaded errors with exponential backoff.
    """
    system_prompt = load_prompt(agent_id)

    if SHOW_PROMPTS:
        _print_prompt(agent_id, system_prompt, user_message, model)

    client = get_client()
    t0 = time.time()

    for attempt in range(max_retries):
        try:
            response = await client.messages.create(
                model=model,
                max_tokens=max_tokens,
                system=system_prompt,
                messages=[{"role": "user", "content": user_message}],
            )
            duration_ms = int((time.time() - t0) * 1000)
            text = response.content[0].text if response.content else ""
            return text, duration_ms
        except anthropic.APIStatusError as e:
            if e.status_code == 529 and attempt < max_retries - 1:
                wait = 2 ** attempt  # 1s, 2s, 4s, 8s, 16s
                print(f"  [overloaded] {agent_id} retry {attempt+1}/{max_retries-1} in {wait}s...")
                await asyncio.sleep(wait)
            else:
                raise


def _print_prompt(agent_id: str, system: str, user: str, model: str) -> None:
    """Print agent prompt to terminal (used when SHOW_PROMPTS is True)."""
    try:
        from rich.console import Console
        from rich.panel import Panel
        from rich.text import Text
        c = Console()
        sys_preview = system[:600] + ("..." if len(system) > 600 else "")
        usr_preview = user[:1200] + ("..." if len(user) > 1200 else "")
        c.print(Panel(
            Text(sys_preview, style="dim"),
            title=f"[bold magenta]{agent_id} -- system prompt[/bold magenta]  [dim]{model}[/dim]",
            border_style="magenta",
        ))
        c.print(Panel(
            Text(usr_preview),
            title=f"[bold magenta]{agent_id} -- user message[/bold magenta]",
            border_style="magenta",
        ))
    except ImportError:
        print(f"\n=== {agent_id} ({model}) ===")
        print(f"SYSTEM: {system[:400]}")
        print(f"USER:   {user[:800]}")


# ---------------------------------------------------------------------------
# Solver response parsing (text-only — no grid extraction)
# ---------------------------------------------------------------------------

def extract_solver_hypothesis(text: str) -> dict:
    """
    Extract hypothesis fields from a solver's text-only response.
    Returns dict with: rule, confidence, reasoning, suggested_tools, suggested_steps, category.
    """
    block_re = re.compile(r"```(?:json)?\s*(.*?)\s*```", re.DOTALL | re.IGNORECASE)
    result = {
        "rule": "",
        "confidence": "medium",
        "reasoning": "",
        "suggested_tools": [],
        "suggested_steps": [],
        "category": "",
    }
    for raw in block_re.findall(text):
        try:
            obj = json.loads(raw)
            if isinstance(obj, dict) and "rule" in obj:
                result["rule"] = obj.get("rule", "")
                result["confidence"] = obj.get("confidence", "medium")
                result["reasoning"] = obj.get("reasoning", "")
                result["suggested_tools"] = obj.get("suggested_tools", [])
                result["suggested_steps"] = obj.get("suggested_steps", [])
                result["category"] = obj.get("category", "")
                break
        except (json.JSONDecodeError, Exception):
            continue
    # Fallback: use entire response as rule if no JSON found
    if not result["rule"]:
        result["rule"] = text[:500]
    return result


# ---------------------------------------------------------------------------
# Round 1 — Solver initial hypotheses (parallel, text-only)
# ---------------------------------------------------------------------------

async def run_solvers_round1(
    task: dict,
    prior_knowledge: str = "",
    human_hypothesis: str = "",
) -> list[SolverEntry]:
    """Run all three solvers in parallel for Round 1 (text-only hypotheses)."""
    task_text = format_task_for_prompt(task)
    knowledge_section = (
        f"\n## Prior Knowledge\n{prior_knowledge}\n" if prior_knowledge.strip() else ""
    )
    human_section = (
        f"\n## Human Hypothesis\n{human_hypothesis}\n"
        "(A human member of the ensemble has offered this observation -- "
        "consider it, but form your own independent analysis.)\n"
        if human_hypothesis.strip() else ""
    )
    user_msg = f"{knowledge_section}{human_section}\n{task_text}\n\nPlease analyze this task and propose your transformation rule."

    async def run_one(agent_id: str) -> SolverEntry:
        text, ms = await call_agent(agent_id, user_msg)
        hyp = extract_solver_hypothesis(text)
        return SolverEntry(
            agent=agent_id,
            round=1,
            rule=hyp["rule"],
            confidence=hyp["confidence"],
            grid=None,  # text-only — no grid
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
# Round 2 — MEDIATOR synthesizes pseudo-code
# ---------------------------------------------------------------------------

async def run_mediator_synthesize(
    task: dict,
    solver_entries: list[SolverEntry],
    prior_knowledge: str = "",
    human_insight: str = "",
    rule_section: str = "",
) -> tuple[str, list[dict], int]:
    """
    Ask MEDIATOR to synthesize solver hypotheses into pseudo-code.
    Returns (raw_response, pseudocode_steps, duration_ms).
    """
    task_text = format_task_for_prompt(task)

    proposals = []
    for e in solver_entries:
        proposals.append(
            f"### {e.agent} (confidence: {e.confidence})\n"
            f"Rule: {e.rule}\n"
            f"Full reasoning:\n{e.raw_response[:1500]}"
        )

    knowledge_section = (
        f"\n## Applicable Rules\n{prior_knowledge}\n" if prior_knowledge.strip() else ""
    )
    human_section = (
        f"\n## Human Insight\n{human_insight}\n" if human_insight.strip() else ""
    )
    rule_mgmt_section = f"\n{rule_section}\n" if rule_section.strip() else ""

    user_msg = (
        f"{knowledge_section}{human_section}"
        f"{task_text}\n\n"
        "## Solver Hypotheses\n\n"
        + "\n\n".join(proposals)
        + "\n\nPlease synthesize these hypotheses into a pseudo-code sequence of tool calls "
        "that the EXECUTOR can run against the demo pairs."
        + rule_mgmt_section
    )

    text, ms = await call_agent("MEDIATOR", user_msg)

    # Parse pseudo-code from response
    from executor import parse_pseudocode
    steps = parse_pseudocode(text)

    return text, steps, ms


# ---------------------------------------------------------------------------
# Round 3+ — MEDIATOR revises pseudo-code after execution failure
# ---------------------------------------------------------------------------

async def run_mediator_revise(
    task: dict,
    solver_entries: list[SolverEntry],
    previous_pseudocode: list[dict],
    execution_trace: str,
    human_insight: str = "",
) -> tuple[str, list[dict], int]:
    """
    Ask MEDIATOR to revise pseudo-code based on execution failure.
    Returns (raw_response, revised_steps, duration_ms).
    """
    task_text = format_task_for_prompt(task)

    proposals = []
    for e in solver_entries:
        proposals.append(f"### {e.agent}: {e.rule[:200]}")

    prev_code = json.dumps(previous_pseudocode, indent=2)

    user_msg = (
        f"{task_text}\n\n"
        "## Solver Hypotheses (for reference)\n"
        + "\n".join(proposals)
        + f"\n\n## Previous pseudo-code (FAILED)\n```json\n{prev_code}\n```\n\n"
        f"## Execution Trace\n{execution_trace}\n\n"
    )

    if human_insight:
        user_msg += f"## Human Insight\n{human_insight}\n\n"

    user_msg += (
        "The pseudo-code failed on one or more demo pairs. "
        "Please analyze the execution trace, identify what went wrong, "
        "and produce a REVISED pseudo-code sequence."
    )

    text, ms = await call_agent("MEDIATOR", user_msg)

    from executor import parse_pseudocode
    steps = parse_pseudocode(text)

    return text, steps, ms


# ---------------------------------------------------------------------------
# Tool generator — Claude writes Python code for new tools on demand
# ---------------------------------------------------------------------------

_TOOL_GENERATOR_SYSTEM = """You are a Python code generator for ARC-AGI grid transformation tools.

Write a single Python function that implements the requested grid transformation.

Requirements:
- Signature: def {name}(grid, **kwargs) -> list
  where `grid` is list[list[int]] (0 = background color)
- Return a NEW 2D list of ints — never modify the input in-place
- You may use numpy internally (imported as `np` and `numpy`)
- Must be deterministic and handle edge cases (empty grid, single cell) gracefully
- No docstring, no imports at module level — just the function body

Return ONLY the function code inside a ```python block. No explanation outside the block."""


async def run_tool_generator(tool_spec: dict) -> tuple[str, int]:
    """
    Ask Claude to generate Python code for a new grid transformation tool.
    Returns (python_code_str, duration_ms).
    """
    name = tool_spec.get("name", "unnamed_tool")
    system = _TOOL_GENERATOR_SYSTEM.replace("{name}", name)

    args_desc = json.dumps(tool_spec.get("args", {}), indent=2)
    behavior = tool_spec.get("behavior", "")
    description = tool_spec.get("description", "")

    user_msg = (
        f"Tool name: `{name}`\n"
        f"Description: {description}\n"
        f"Arguments:\n{args_desc}\n\n"
        f"Behavior:\n{behavior}\n\n"
        f"Write `def {name}(grid, **kwargs)` implementing the above."
    )

    client = get_client()
    t0 = time.time()
    for attempt in range(5):
        try:
            response = await client.messages.create(
                model=DEFAULT_MODEL,
                max_tokens=2048,
                system=system,
                messages=[{"role": "user", "content": user_msg}],
            )
            break
        except anthropic.APIStatusError as e:
            if e.status_code == 529 and attempt < 4:
                await asyncio.sleep(2 ** attempt)
            else:
                raise

    duration_ms = int((time.time() - t0) * 1000)
    raw = response.content[0].text if response.content else ""

    # Extract code from ```python block
    match = re.search(r"```python\s*(.*?)\s*```", raw, re.DOTALL)
    code = match.group(1).strip() if match else raw.strip()

    return code, duration_ms
