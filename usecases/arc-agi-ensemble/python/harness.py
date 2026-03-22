"""
harness.py — CLI test runner for the Python ARC-AGI ensemble.

Usage:
  python harness.py                          # run first task
  python harness.py --task-id 1e0a9b12       # specific task
  python harness.py --limit 10               # first 10 tasks
  python harness.py --limit 5 --offset 20   # tasks 21-25
  python harness.py --human                  # enable human-in-the-loop
  python harness.py --charts                 # save charts per task
  python harness.py --output results.json    # custom output file

Data directory default: C:/_backup/arctest2025/data/training
Override with --data-dir.
"""

from __future__ import annotations
import argparse
import asyncio
import json
import os
import sys
import time
from pathlib import Path

from rich.console import Console
from rich.table import Table
from rich.panel import Panel

# ---------------------------------------------------------------------------
# Resolve paths before importing local modules
# ---------------------------------------------------------------------------
_HERE = Path(__file__).parent
sys.path.insert(0, str(_HERE))

from ensemble import run_ensemble
from knowledge import KnowledgeBase
from metadata import TaskMetadata, compute_outcome
from visualize import save_all_charts
import agents
from agents import DEFAULT_MODEL

console = Console()

DEFAULT_DATA_DIR = "C:/_backup/arctest2025/data/training"
DEFAULT_OUTPUT   = "results.json"


# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="ARC-AGI Python Ensemble Test Harness")
    p.add_argument("--data-dir", default=DEFAULT_DATA_DIR)
    p.add_argument("--limit",    type=int, default=1)
    p.add_argument("--offset",   type=int, default=0)
    p.add_argument("--task-id",  default="")
    p.add_argument("--output",   default=DEFAULT_OUTPUT)
    p.add_argument("--human",    action="store_true", help="Enable human-in-the-loop checkpoints")
    p.add_argument("--prompts",  action="store_true", help="Print full prompts sent to each agent")
    p.add_argument("--charts",   action="store_true", help="Save charts per task")
    p.add_argument("--charts-dir", default="charts")
    p.add_argument("--knowledge", default="", help="Path to knowledge.json (default: auto)")
    p.add_argument("--quiet",    action="store_true", help="Minimal output")
    return p.parse_args()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

async def main() -> None:
    args = parse_args()
    verbose = not args.quiet
    agents.SHOW_PROMPTS = args.prompts

    # Load API key
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        # Try loading from common location
        key_file = Path("P:/_access/Security/api_keys.env")
        if key_file.exists():
            for line in key_file.read_text().splitlines():
                if line.startswith("ANTHROPIC_API_KEY="):
                    os.environ["ANTHROPIC_API_KEY"] = line.split("=", 1)[1].strip()
                    break
        if not os.environ.get("ANTHROPIC_API_KEY"):
            console.print("[red]ANTHROPIC_API_KEY not set[/red]")
            sys.exit(1)

    # Load data
    data_dir = Path(args.data_dir)
    challenges_path = data_dir / "arc-agi_training_challenges.json"
    solutions_path  = data_dir / "arc-agi_training_solutions.json"

    if not challenges_path.exists():
        console.print(f"[red]Challenges file not found: {challenges_path}[/red]")
        sys.exit(1)

    challenges = json.loads(challenges_path.read_text(encoding="utf-8"))
    solutions  = json.loads(solutions_path.read_text(encoding="utf-8")) if solutions_path.exists() else {}

    # Select tasks
    if args.task_id:
        task_ids = [args.task_id]
    else:
        all_ids = list(challenges.keys())
        task_ids = all_ids[args.offset : args.offset + args.limit]

    # Knowledge base
    kb_path = args.knowledge or None
    kb = KnowledgeBase(kb_path)

    console.print(Panel(
        f"[bold]ARC-AGI Python Ensemble[/bold]\n"
        f"Model:  [cyan]{DEFAULT_MODEL}[/cyan]\n"
        f"Tasks:  {len(task_ids)} (offset={args.offset}, limit={args.limit})\n"
        f"Flags:  human={'on' if args.human else 'off'}  "
        f"prompts={'on' if args.prompts else 'off'}  "
        f"charts={'on' if args.charts else 'off'}\n"
        f"KB:     {kb.path}  {kb.stats()}",
        title="Harness"
    ))

    all_results: list[dict] = []
    correct_count = 0

    for i, task_id in enumerate(task_ids, 1):
        task = challenges.get(task_id)
        if task is None:
            console.print(f"[yellow]Task {task_id} not found, skipping[/yellow]")
            continue

        expected = solutions.get(task_id, [None])[0]

        console.rule(f"[{i}/{len(task_ids)}] {task_id}")

        t0 = time.time()
        meta: TaskMetadata = await run_ensemble(
            task=task,
            task_id=task_id,
            expected=expected,
            knowledge_base=kb,
            human_in_loop=args.human,
            verbose=verbose,
        )

        if meta.correct:
            correct_count += 1

        row = {
            "task_id": task_id,
            "correct": meta.correct,
            "cell_accuracy": meta.cell_accuracy,
            "converged": meta.mediator.converged if meta.mediator else False,
            "rounds": meta.rounds_completed,
            "duration_ms": meta.total_duration_ms,
            "kb_updates": meta.mediator.kb_updates if meta.mediator else {},
        }
        all_results.append(row)

        if args.charts and expected:
            saved = save_all_charts(meta, expected=expected, out_dir=args.charts_dir)
            console.print(f"  Charts: {', '.join(saved)}")

    # ------------------------------------------------------------------
    # Summary
    # ------------------------------------------------------------------
    total = len(all_results)
    accuracy = correct_count / total if total > 0 else 0.0
    avg_ms = sum(r["duration_ms"] for r in all_results) / max(total, 1)
    conv_rate = sum(1 for r in all_results if r.get("converged")) / max(total, 1)

    table = Table(title="Run Summary")
    table.add_column("Metric")
    table.add_column("Value")
    table.add_row("Tasks run", str(total))
    table.add_row("Correct", f"{correct_count}/{total}  ({accuracy*100:.1f}%)")
    table.add_row("Avg duration", f"{avg_ms/1000:.1f}s")
    table.add_row("Convergence rate", f"{conv_rate*100:.1f}%")
    table.add_row("KB patterns", str(kb.stats()["patterns"]))
    console.print(table)

    # Save results
    output = {
        "summary": {
            "correct": correct_count,
            "total": total,
            "accuracy": accuracy,
            "avg_ms": avg_ms,
            "conv_rate": conv_rate,
            "kb": kb.stats(),
        },
        "tasks": all_results,
    }
    Path(args.output).write_text(json.dumps(output, indent=2), encoding="utf-8")
    console.print(f"Results written to [bold]{args.output}[/bold]")


if __name__ == "__main__":
    asyncio.run(main())
