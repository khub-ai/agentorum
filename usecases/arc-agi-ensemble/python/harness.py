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
import datetime
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

import ensemble
from ensemble import run_ensemble
from rules import RuleEngine
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
    p.add_argument("--hypothesis",     default="", metavar="TEXT",
                   help="Pre-fill your hypothesis (shown before solvers run)")
    p.add_argument("--insight",        default="", metavar="TEXT",
                   help="Pre-fill your insight (shown after solver hypotheses, before MEDIATOR)")
    p.add_argument("--revision-hint",  default="", metavar="TEXT",
                   help="Pre-fill your revision hint (shown each time EXECUTOR fails)")
    p.add_argument("--prompts",  action="store_true", help="Print full prompts sent to each agent")
    p.add_argument("--charts",   action="store_true", help="Save charts per task")
    p.add_argument("--charts-dir", default="charts")
    p.add_argument("--rules",        default="", help="Path to rules.json (default: auto)")
    p.add_argument("--max-revisions", type=int, default=None, help="Override MAX_REVISIONS (default: 5)")
    p.add_argument("--quiet",    action="store_true", help="Minimal output")
    p.add_argument("--dataset",  default="training",
                   help="Dataset name for leaderboard tracking (training/eval/test)")
    return p.parse_args()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

async def main() -> None:
    args = parse_args()
    verbose = not args.quiet
    agents.SHOW_PROMPTS = args.prompts
    if args.max_revisions is not None:
        ensemble.MAX_REVISIONS = args.max_revisions

    # Load API key
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
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

    # Rule engine
    rules_path = args.rules or None
    rules = RuleEngine(rules_path)

    console.print(Panel(
        f"[bold]ARC-AGI Python Ensemble[/bold]\n"
        f"Model:  [cyan]{DEFAULT_MODEL}[/cyan]\n"
        f"Tasks:  {len(task_ids)} (offset={args.offset}, limit={args.limit})\n"
        f"Flags:  human={'on' if args.human else 'off'}  "
        f"prompts={'on' if args.prompts else 'off'}  "
        f"charts={'on' if args.charts else 'off'}\n"
        f"Rules:  {rules.path}  {rules.stats_summary()}",
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
            rule_engine=rules,
            human_in_loop=args.human,
            human_hypothesis=args.hypothesis,
            human_insight=args.insight,
            human_revision_hint=args.revision_hint,
            verbose=verbose,
            dataset=args.dataset,
        )

        if meta.correct:
            correct_count += 1

        row = {
            "task_id":         task_id,
            "correct":         meta.correct,
            "cell_accuracy":   meta.cell_accuracy,
            "converged":       meta.mediator.converged if meta.mediator else False,
            "rounds":          meta.rounds_completed,
            "duration_ms":     meta.total_duration_ms,
            "cost_usd":        meta.cost_usd,
            "input_tokens":    meta.input_tokens,
            "output_tokens":   meta.output_tokens,
            "api_calls":       meta.api_calls,
            "human_hints":     meta.human_hints_used,
            "tools_generated": meta.tools_generated,
            "model":           meta.model,
            "dataset":         meta.dataset,
        }
        all_results.append(row)

        if args.charts and expected:
            saved = save_all_charts(meta, expected=expected, out_dir=args.charts_dir)
            console.print(f"  Charts: {', '.join(saved)}")

    # ------------------------------------------------------------------
    # Summary
    # ------------------------------------------------------------------
    total = len(all_results)
    accuracy     = correct_count / total if total > 0 else 0.0
    avg_ms       = sum(r["duration_ms"] for r in all_results) / max(total, 1)
    conv_rate    = sum(1 for r in all_results if r.get("converged")) / max(total, 1)
    total_cost   = sum(r.get("cost_usd", 0.0) for r in all_results)
    avg_cost     = total_cost / max(total, 1)
    total_tokens = sum(r.get("input_tokens", 0) + r.get("output_tokens", 0) for r in all_results)
    hints_count  = sum(1 for r in all_results if r.get("human_hints"))
    run_ts       = datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")

    table = Table(title="Run Summary")
    table.add_column("Metric")
    table.add_column("Value")
    table.add_row("Tasks run",        str(total))
    table.add_row("Correct",          f"{correct_count}/{total}  ({accuracy*100:.1f}%)")
    table.add_row("Avg duration",     f"{avg_ms/1000:.1f}s")
    table.add_row("Convergence rate", f"{conv_rate*100:.1f}%")
    table.add_row("Total cost (USD)", f"${total_cost:.4f}")
    table.add_row("Avg cost / task",  f"${avg_cost:.4f}")
    table.add_row("Total tokens",     f"{total_tokens:,}")
    table.add_row("Human hints used", f"{hints_count}/{total} tasks")
    table.add_row("Model",            DEFAULT_MODEL)
    table.add_row("Dataset",          args.dataset)
    table.add_row("Rules (active)",   str(rules.stats_summary()["active"]))
    table.add_row("Rules (total)",    str(rules.stats_summary()["total"]))
    console.print(table)

    # Save results
    output = {
        "summary": {
            "correct":       correct_count,
            "total":         total,
            "accuracy":      accuracy,
            "avg_ms":        avg_ms,
            "conv_rate":     conv_rate,
            "total_cost_usd": round(total_cost, 6),
            "avg_cost_usd":   round(avg_cost, 6),
            "total_tokens":   total_tokens,
            "hints_used":     hints_count,
            "model":          DEFAULT_MODEL,
            "dataset":        args.dataset,
            "timestamp":      run_ts,
            "rules":          rules.stats_summary(),
        },
        "tasks": all_results,
    }
    Path(args.output).write_text(json.dumps(output, indent=2), encoding="utf-8")
    console.print(f"Results written to [bold]{args.output}[/bold]")


if __name__ == "__main__":
    asyncio.run(main())
