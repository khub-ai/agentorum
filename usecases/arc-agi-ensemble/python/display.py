"""
display.py — Rich terminal display for human participation in the ARC-AGI ensemble.

Structured checkpoints at each debate round so you can:
  1. Study the puzzle before solvers run (and optionally submit your own hypothesis)
  2. Review solver proposals after Round 1
  3. React to CRITIC verdicts after Round 2 — inject an insight into Round 3
  4. Review revised proposals after Round 3 — give a final insight to the MEDIATOR
  5. See the final answer vs expected output
"""

from __future__ import annotations
from typing import Optional

from rich.columns import Columns
from rich.console import Console
from rich.panel import Panel
from rich.rule import Rule
from rich.table import Table
from rich.text import Text
from rich import box

from grid_tools import Grid, cell_accuracy
from metadata import SolverEntry, CriticVerdict, MediatorDecision, TaskMetadata
from rules import RuleMatch, RuleEngine

console = Console()

# ---------------------------------------------------------------------------
# ARC color palette for rich (hex backgrounds)
# ---------------------------------------------------------------------------

_BG = [
    "#000000",  # 0 black
    "#1E93FF",  # 1 blue
    "#F93800",  # 2 red
    "#4FCC30",  # 3 green
    "#FFDC00",  # 4 yellow
    "#999999",  # 5 gray
    "#E53AA3",  # 6 magenta
    "#FF851B",  # 7 orange
    "#87D8F1",  # 8 azure
    "#921231",  # 9 maroon
]

# Use white text on dark backgrounds, black on light ones
_DARK_BG = {0, 2, 6, 9}  # black, red, magenta, maroon

_CONF_STYLE = {"high": "bold green", "medium": "yellow", "low": "red"}
_VERDICT_STYLE = {"PASS": "bold green", "FAIL": "bold red"}
_VERDICT_BORDER = {"PASS": "green", "FAIL": "red"}


# ---------------------------------------------------------------------------
# Grid rendering
# ---------------------------------------------------------------------------

def _render_grid(grid: Optional[Grid]) -> Text:
    """
    Render an ARC grid as a Rich Text with colored 2-space blocks,
    surrounded by a Unicode bounding box.

      ┌──────────┐
      │  ██  ██  │
      │  ██  ██  │
      └──────────┘
    """
    t = Text()
    if not grid:
        t.append("(none)", style="dim italic")
        return t

    cols = len(grid[0]) if grid[0] else 0
    # Each cell = 2 chars, borders add 1 each side → total inner width = cols*2
    inner_w = cols * 2
    box_style = "dim"

    # Top border  (ASCII for Windows cp1252 compatibility)
    t.append("+" + "-" * inner_w + "+\n", style=box_style)

    for i, row in enumerate(grid):
        t.append("|", style=box_style)
        for val in row:
            idx = val if 0 <= val <= 9 else 0
            bg = _BG[idx]
            fg = "white" if idx in _DARK_BG else "black"
            t.append("  ", style=f"{fg} on {bg}")
        t.append("|", style=box_style)
        if i < len(grid) - 1:
            t.append("\n")

    # Bottom border
    t.append("\n+" + "-" * inner_w + "+", style=box_style)

    return t


def _pair_table(inp: Optional[Grid], out: Optional[Grid]) -> Table:
    """Compact input→output table for a single demo pair."""
    t = Table(show_header=False, box=None, padding=(0, 1))
    t.add_column("input", no_wrap=True)
    t.add_column("arrow", no_wrap=True)
    t.add_column("output", no_wrap=True)
    t.add_row(_render_grid(inp), Text("→", style="bold dim"), _render_grid(out))
    return t


def _grid_panel(grid: Optional[Grid], title: str, border: str = "dim",
                footer: str = "") -> Panel:
    return Panel(
        _render_grid(grid),
        title=title,
        subtitle=footer or None,
        border_style=border,
        expand=False,
    )


# ---------------------------------------------------------------------------
# Checkpoint 0 — Puzzle display
# ---------------------------------------------------------------------------

def show_puzzle(task: dict, task_id: str,
                expected: Optional[Grid] = None) -> None:
    """Show all demo pairs, the test input, and (if known) the expected output."""
    console.print()
    console.print(Rule(f"[bold cyan]PUZZLE  {task_id}[/bold cyan]", style="cyan"))

    train = task.get("train", [])
    console.print(f"  [dim]{len(train)} demonstration pair(s)  →  study the pattern[/dim]\n")

    pair_panels = []
    for i, pair in enumerate(train):
        pair_panels.append(Panel(
            _pair_table(pair.get("input"), pair.get("output")),
            title=f"Demo {i + 1}",
            border_style="dim",
            expand=False,
        ))
    console.print(Columns(pair_panels, padding=(0, 2)))

    test_inp = task["test"][0]["input"] if task.get("test") else None
    console.print()
    test_panels = [
        _grid_panel(test_inp,
                    title="[cyan]TEST INPUT[/cyan]",
                    border="cyan"),
    ]
    if expected is not None:
        test_panels.append(_grid_panel(expected,
                                       title="[green]CORRECT OUTPUT[/green]",
                                       border="green"))
    console.print(Columns(test_panels, padding=(0, 2)))
    console.print()


# ---------------------------------------------------------------------------
# Checkpoint 1 — Round 1 proposals
# ---------------------------------------------------------------------------

def show_r1_proposals(entries: list[SolverEntry]) -> None:
    """Display Round 1 solver proposals side by side."""
    console.print(Rule("[bold blue]Round 1 — Solver Proposals[/bold blue]", style="blue"))
    panels = []
    for e in entries:
        cs = _CONF_STYLE.get(e.confidence, "")
        rule_text = e.rule[:140] + ("…" if len(e.rule) > 140 else "")
        body = Text()
        body.append_text(_render_grid(e.grid))
        body.append(f"\n\n{rule_text}", style="dim")
        panels.append(Panel(
            body,
            title=f"{e.agent.replace('SOLVER-', '')}  [{cs}]{e.confidence}[/{cs}]",
            border_style="blue",
            expand=False,
        ))
    console.print(Columns(panels, padding=(0, 2)))
    console.print()


# ---------------------------------------------------------------------------
# Checkpoint 2 — CRITIC verdicts
# ---------------------------------------------------------------------------

def show_critic_results(entries: list[SolverEntry], critic: CriticVerdict,
                        expected: Optional[Grid] = None) -> None:
    """Compact verdict table with optional expected-output reference."""
    console.print(Rule("[bold yellow]Round 2 — CRITIC Verdicts[/bold yellow]", style="yellow"))

    t = Table(show_header=True, box=box.SIMPLE, header_style="bold yellow")
    t.add_column("Agent", style="bold")
    t.add_column("Verdict", justify="center")
    t.add_column("Confidence", justify="center")
    t.add_column("Rule (R1)", style="dim", no_wrap=False, max_width=70)

    for e in entries:
        verdict = critic.verdicts.get(e.agent, "?")
        vs = _VERDICT_STYLE.get(verdict, "")
        cs = _CONF_STYLE.get(e.confidence, "")
        t.add_row(
            e.agent.replace("SOLVER-", ""),
            f"[{vs}]{verdict}[/{vs}]",
            f"[{cs}]{e.confidence}[/{cs}]",
            e.rule[:100] + ("…" if len(e.rule) > 100 else ""),
        )
    console.print(t)

    row = []
    if critic.notes:
        row.append(Panel(
            Text(critic.notes[:400], style="dim"),
            title="CRITIC notes",
            border_style="yellow",
            padding=(0, 1),
            expand=False,
        ))
    if expected is not None:
        row.append(_grid_panel(expected, title="[green]CORRECT OUTPUT[/green]",
                               border="green"))
    if row:
        console.print(Columns(row, padding=(0, 2)))
    console.print()


# ---------------------------------------------------------------------------
# Checkpoint 3 — Round 3 revised proposals
# ---------------------------------------------------------------------------

def show_r3_proposals(
    r1: list[SolverEntry],
    r3: list[SolverEntry],
    critic: Optional[CriticVerdict],
    expected: Optional[Grid] = None,
) -> None:
    """
    Show R3 revised grids only — R1 grids were already shown.
    Flags REVISED / UNCHANGED, and shows the correct output for comparison.
    """
    from grid_tools import grids_equal, cell_accuracy

    console.print(Rule("[bold blue]Round 3 — Revised Proposals[/bold blue]", style="blue"))
    r1_map = {e.agent: e for e in r1}
    panels = []

    for e3 in r3:
        e1 = r1_map.get(e3.agent)
        verdict = critic.verdicts.get(e3.agent, "?") if critic else "?"
        vs = _VERDICT_STYLE.get(verdict, "")
        cs = _CONF_STYLE.get(e3.confidence, "")
        short = e3.agent.replace("SOLVER-", "")

        changed = not (e1 and e1.grid and e3.grid and grids_equal(e1.grid, e3.grid))
        delta = "[green]REVISED[/green]" if changed else "[dim]UNCHANGED[/dim]"
        rule_text = e3.rule[:100] + ("…" if len(e3.rule) > 100 else "")

        acc_str = ""
        if expected and e3.grid:
            acc = cell_accuracy(e3.grid, expected)
            acc_str = f"  {acc*100:.0f}% acc"

        body = Text()
        body.append_text(_render_grid(e3.grid))
        body.append(f"\n{rule_text}", style="dim")

        panels.append(Panel(
            body,
            title=f"{short}  [{cs}]{e3.confidence}[/{cs}]  {delta}{acc_str}",
            subtitle=f"R1 was [{vs}]{verdict}[/{vs}]",
            border_style="blue" if changed else "dim",
            expand=False,
        ))

    if expected is not None:
        panels.append(_grid_panel(expected, title="[green]CORRECT OUTPUT[/green]",
                                  border="green"))

    console.print(Columns(panels, padding=(0, 2)))
    console.print()


# ---------------------------------------------------------------------------
# Checkpoint 4 — Final result
# ---------------------------------------------------------------------------

def show_final_result(meta: TaskMetadata, expected: Optional[Grid]) -> None:
    """Display MEDIATOR answer vs expected output."""
    correct = meta.correct
    color = "green" if correct else "red"
    label = "✓ CORRECT" if correct else "✗ WRONG"
    console.print(Rule(f"[bold {color}]Final Result — {label}[/bold {color}]",
                       style=color))

    answer = meta.mediator.answer if meta.mediator else None
    acc = f"{(meta.cell_accuracy or 0) * 100:.1f}% cell accuracy"
    dur = f"{meta.total_duration_ms / 1000:.1f}s"

    panels = [
        _grid_panel(answer, title=f"[{color}]MEDIATOR — {label}[/{color}]",
                    border=color, footer=acc),
    ]
    if expected is not None:
        panels.append(_grid_panel(expected, title="Expected", border="dim"))

    console.print(Columns(panels, padding=(0, 2)))
    console.print(f"  [dim]Duration: {dur}  |  Rounds: {meta.rounds_completed}[/dim]\n")


# ---------------------------------------------------------------------------
# Human input prompts
# ---------------------------------------------------------------------------

def human_checkpoint(prompt: str, context: str = "") -> str:
    """
    Pause and ask the human for input.
    Returns the entered string, or "" if the user presses Enter with no input.
    """
    if context:
        console.print(Panel(Text(context, style="dim"), title="Context", border_style="dim"))

    console.print(Panel(
        f"[bold cyan]{prompt}[/bold cyan]\n[dim](Press Enter with no input to skip)[/dim]",
        title="[cyan]Your turn[/cyan]",
        border_style="cyan",
    ))
    try:
        response = input("  > ").strip()
    except (EOFError, KeyboardInterrupt):
        response = ""
    console.print()
    return response


def human_hypothesis_checkpoint(task_id: str) -> str:
    """Ask the human for their own hypothesis before the solvers run."""
    return human_checkpoint(
        prompt=(
            "What pattern do you see?\n"
            "  You can describe a rule, suggest a transformation, or leave blank\n"
            "  to let the solvers go first.\n"
            "  Your input will be shared with all agents as 'Human Hypothesis'."
        ),
        context=f"Task {task_id} — study the demo pairs above before answering.",
    )


def human_post_critic_checkpoint() -> str:
    """Ask for an insight to inject into Round 3 solver revisions."""
    return human_checkpoint(
        prompt=(
            "CRITIC has evaluated the solvers.\n"
            "  Do you see what they are missing?\n"
            "  Your insight will be injected into Round 3 for all solvers to consider."
        ),
    )


def human_pre_mediator_checkpoint() -> str:
    """Ask for a final insight before the MEDIATOR decides."""
    return human_checkpoint(
        prompt=(
            "Solvers have submitted their revised proposals.\n"
            "  Any final observation or preference before the MEDIATOR decides?\n"
            "  Your input will be included in the MEDIATOR's context."
        ),
    )


# ---------------------------------------------------------------------------
# Rule state visualization
# ---------------------------------------------------------------------------

_LINEAGE_STYLE = {
    "new": "bold cyan",
    "generalized": "bold yellow",
    "specialized": "bold magenta",
    "merged": "bold blue",
}

_LINEAGE_ICON = {
    "new": "+",
    "generalized": "^",     # broader
    "specialized": "v",     # narrower
    "merged": "<>",          # combined
}


def show_rule_matches(matches: list[RuleMatch],
                      engine: RuleEngine) -> None:
    """Display which rules matched the current puzzle (Round 0)."""
    if not matches:
        console.print(Panel(
            "[dim]No rules matched this puzzle — the ensemble starts from scratch.[/dim]",
            title="[cyan]Round 0 — Rule Matching[/cyan]",
            border_style="dim",
        ))
        return

    console.print(Rule("[bold cyan]Round 0 — Rule Matching[/bold cyan]", style="cyan"))

    t = Table(show_header=True, box=box.SIMPLE, header_style="bold cyan")
    t.add_column("ID", style="bold")
    t.add_column("Confidence", justify="center")
    t.add_column("Success Rate", justify="center")
    t.add_column("Fired", justify="center", style="dim")
    t.add_column("Condition", no_wrap=False, max_width=50)
    t.add_column("Action", no_wrap=False, max_width=50, style="dim")

    for m in matches:
        stats = m.rule["stats"]
        fired = stats["fired"]
        sr = stats["succeeded"] / fired if fired > 0 else 0.5
        sr_style = "green" if sr >= 0.7 else ("yellow" if sr >= 0.4 else "red")
        cs = _CONF_STYLE.get(m.confidence, "")
        t.add_row(
            m.rule_id,
            f"[{cs}]{m.confidence}[/{cs}]",
            f"[{sr_style}]{sr:.0%}[/{sr_style}]",
            str(fired),
            m.rule["condition"][:80],
            m.rule["action"][:80],
        )

    console.print(t)
    console.print(
        f"  [dim]{len(matches)} rule(s) will be injected into solver prompts[/dim]\n"
    )


def show_rule_updates(
    fired: list[RuleMatch],
    created: list[dict],
    success: bool,
    engine: RuleEngine,
) -> None:
    """
    Show all rule state changes after a task completes.
    Covers: stats updates on fired rules, and newly created/evolved rules.
    """
    color = "green" if success else "red"
    outcome = "SUCCESS" if success else "FAILURE"
    console.print(Rule(
        f"[bold {color}]Rule Updates — {outcome}[/bold {color}]",
        style=color,
    ))

    # --- Fired rules: stats update ---
    if fired:
        t = Table(show_header=True, box=box.SIMPLE, header_style="bold")
        t.add_column("ID", style="bold")
        t.add_column("Condition", no_wrap=False, max_width=50)
        t.add_column("Fired", justify="center")
        t.add_column("Succeeded", justify="center", style="green")
        t.add_column("Failed", justify="center", style="red")
        t.add_column("Success Rate", justify="center")
        t.add_column("Update", justify="center")

        for m in fired:
            # Re-read from engine to get updated stats
            r = engine.get(m.rule_id) or m.rule
            stats = r["stats"]
            sr = stats["succeeded"] / stats["fired"] if stats["fired"] > 0 else 0
            sr_style = "green" if sr >= 0.7 else ("yellow" if sr >= 0.4 else "red")
            delta = f"[{color}]+1 {'succeeded' if success else 'failed'}[/{color}]"
            t.add_row(
                m.rule_id,
                r["condition"][:60],
                str(stats["fired"]),
                str(stats["succeeded"]),
                str(stats["failed"]),
                f"[{sr_style}]{sr:.0%}[/{sr_style}]",
                delta,
            )
        console.print(t)

    # --- Newly created/evolved rules ---
    if created:
        console.print()
        console.print(f"  [bold]New rules created by MEDIATOR:[/bold]")
        for r in created:
            lineage = r.get("lineage", {})
            ltype = lineage.get("type", "new")
            icon = _LINEAGE_ICON.get(ltype, "?")
            lstyle = _LINEAGE_STYLE.get(ltype, "")
            parent_ids = lineage.get("parent_ids", [])
            reason = lineage.get("reason", "")

            header = f"[{lstyle}][{icon}] {r['id']} ({ltype})[/{lstyle}]"
            if parent_ids:
                header += f"  [dim]from {', '.join(parent_ids)}[/dim]"

            body = Text()
            body.append("CONDITION: ", style="bold")
            body.append(r["condition"] + "\n")
            body.append("ACTION: ", style="bold")
            body.append(r["action"])
            if reason:
                body.append(f"\nREASON: ", style="bold yellow")
                body.append(reason, style="yellow")

            console.print(Panel(
                body,
                title=header,
                border_style=lstyle.replace("bold ", "") if lstyle else "dim",
                expand=False,
            ))

    if not fired and not created:
        console.print("  [dim]No rule changes for this task.[/dim]")

    console.print()
