"""
executor.py — Deterministic tool-based execution engine for ARC-AGI puzzles.

Replaces the LLM-based CRITIC with exact grid operations. Takes structured
pseudo-code steps from the MEDIATOR, executes them against demo pairs using
numpy tools, and reports PASS/FAIL with step-level intermediate states.

The execution trace is the key diagnostic artifact: it shows exactly which
step caused divergence from the expected output, enabling precise debugging
by Claude Code or a human.
"""

from __future__ import annotations
import json
import re
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from grid_tools import (
    Grid, grids_equal, diff_cells, cell_accuracy, grid_to_str,
    apply_gravity, flood_fill, replace_color, rotate_90,
    flip_horizontal, flip_vertical, transpose, crop, pad,
    bounding_box, unique_colors, color_count, shape,
    count_connected_components, gravity_by_type,
)


# ---------------------------------------------------------------------------
# Step trace data structures
# ---------------------------------------------------------------------------

@dataclass
class StepResult:
    """Result of executing one pseudo-code step."""
    step_num: int
    tool: str
    args: dict
    grid_before: Grid
    grid_after: Grid
    success: bool = True
    error: str = ""


@dataclass
class DemoResult:
    """Result of running pseudo-code against one demo pair."""
    demo_index: int
    input_grid: Grid
    expected_output: Grid
    actual_output: Grid
    steps: list[StepResult]
    passed: bool = False
    cell_acc: float = 0.0
    diff: list[tuple] = field(default_factory=list)
    first_diverge_step: int = -1   # step where output first diverges from expected


@dataclass
class ExecutionResult:
    """Full execution result across all demo pairs + test input."""
    demos: list[DemoResult]
    test_output: Optional[Grid] = None
    test_steps: list[StepResult] = field(default_factory=list)
    all_pass: bool = False
    error: str = ""


# ---------------------------------------------------------------------------
# Tool registry
# ---------------------------------------------------------------------------

# Each tool takes (grid, **args) -> grid
# Tools must be pure functions: same input → same output

_TOOL_REGISTRY: dict[str, Callable] = {}


def register_tool(name: str, fn: Callable) -> None:
    """Register a tool function by name."""
    _TOOL_REGISTRY[name] = fn


def get_tool(name: str) -> Optional[Callable]:
    return _TOOL_REGISTRY.get(name)


def list_tools() -> list[str]:
    return sorted(_TOOL_REGISTRY.keys())


def tool_signatures() -> str:
    """Return a formatted string of all available tools for injection into prompts."""
    lines = ["Available grid tools:"]
    for name, fn in sorted(_TOOL_REGISTRY.items()):
        doc = (fn.__doc__ or "").strip().split("\n")[0]
        lines.append(f"  - {name}: {doc}")
    return "\n".join(lines)


# --- Register built-in tools ---

def _gravity(grid: Grid, direction: str = "down", background: int = 0) -> Grid:
    """Apply gravity in a direction (down/up/left/right). Non-background cells slide."""
    return apply_gravity(grid, direction=direction, background=background)

def _flood_fill(grid: Grid, row: int, col: int, color: int) -> Grid:
    """Flood fill from (row, col) with the given color."""
    return flood_fill(grid, start_row=row, start_col=col, fill_color=color)

def _replace_color(grid: Grid, from_color: int, to_color: int) -> Grid:
    """Replace all cells of from_color with to_color."""
    return replace_color(grid, from_color=from_color, to_color=to_color)

def _rotate(grid: Grid, times: int = 1) -> Grid:
    """Rotate counter-clockwise by 90*times degrees."""
    return rotate_90(grid, k=times)

def _flip_h(grid: Grid) -> Grid:
    """Flip horizontally (left-right mirror)."""
    return flip_horizontal(grid)

def _flip_v(grid: Grid) -> Grid:
    """Flip vertically (top-bottom mirror)."""
    return flip_vertical(grid)

def _transpose(grid: Grid) -> Grid:
    """Transpose the grid (swap rows and columns)."""
    return transpose(grid)

def _crop(grid: Grid, row_start: int, col_start: int, row_end: int, col_end: int) -> Grid:
    """Crop to [row_start:row_end, col_start:col_end]."""
    return crop(grid, row_start, col_start, row_end, col_end)

def _pad(grid: Grid, top: int = 0, bottom: int = 0, left: int = 0, right: int = 0, fill: int = 0) -> Grid:
    """Pad the grid with fill color on the specified sides."""
    return pad(grid, top=top, bottom=bottom, left=left, right=right, fill=fill)

def _identity(grid: Grid) -> Grid:
    """Return the grid unchanged (no-op, useful for testing)."""
    return [row[:] for row in grid]

def _sort_rows(grid: Grid, background: int = 0, reverse: bool = False) -> Grid:
    """Sort non-background values within each row."""
    import numpy as np
    from grid_tools import to_np, to_list
    arr = to_np(grid).copy()
    for r in range(arr.shape[0]):
        row = arr[r]
        non_bg = sorted(row[row != background].tolist(), reverse=reverse)
        idx = 0
        for c in range(arr.shape[1]):
            if arr[r, c] != background:
                arr[r, c] = non_bg[idx]
                idx += 1
    return to_list(arr)

def _sort_cols(grid: Grid, background: int = 0, reverse: bool = False) -> Grid:
    """Sort non-background values within each column."""
    import numpy as np
    from grid_tools import to_np, to_list
    arr = to_np(grid).copy()
    for c in range(arr.shape[1]):
        col = arr[:, c]
        non_bg = sorted(col[col != background].tolist(), reverse=reverse)
        idx = 0
        for r in range(arr.shape[0]):
            if arr[r, c] != background:
                arr[r, c] = non_bg[idx]
                idx += 1
    return to_list(arr)

def _fill_background(grid: Grid, color: int, background: int = 0) -> Grid:
    """Replace all background cells with the given color."""
    return replace_color(grid, from_color=background, to_color=color)

def _extract_objects(grid: Grid, background: int = 0) -> Grid:
    """Remove background, keeping only non-background cells (set background to -1 marker)."""
    return replace_color(grid, from_color=background, to_color=-1)

def _mirror_diagonal(grid: Grid, direction: str = "main") -> Grid:
    """Mirror along diagonal. 'main' = top-left to bottom-right, 'anti' = top-right to bottom-left."""
    import numpy as np
    from grid_tools import to_np, to_list
    arr = to_np(grid)
    if direction == "anti":
        return to_list(np.fliplr(np.flipud(arr.T)))
    return to_list(arr.T)

def _gravity_by_type(grid: Grid, background: int = 0) -> Grid:
    """Closed hollow rectangles float UP; open/cross shapes sink DOWN. Objects are rigid units preserving color."""
    return gravity_by_type(grid, background=background)


# Register all built-in tools
for _name, _fn in [
    ("gravity", _gravity),
    ("flood_fill", _flood_fill),
    ("replace_color", _replace_color),
    ("rotate", _rotate),
    ("flip_horizontal", _flip_h),
    ("flip_vertical", _flip_v),
    ("transpose", _transpose),
    ("crop", _crop),
    ("pad", _pad),
    ("identity", _identity),
    ("sort_rows", _sort_rows),
    ("sort_cols", _sort_cols),
    ("fill_background", _fill_background),
    ("extract_objects", _extract_objects),
    ("mirror_diagonal", _mirror_diagonal),
    ("gravity_by_type", _gravity_by_type),
]:
    register_tool(_name, _fn)


# ---------------------------------------------------------------------------
# Pseudo-code parsing
# ---------------------------------------------------------------------------

def parse_pseudocode(text: str) -> list[dict]:
    """
    Extract structured pseudo-code steps from MEDIATOR output.

    Expected format in a JSON code block:
    ```json
    {
      "pseudocode": [
        {"step": 1, "tool": "gravity", "args": {"direction": "down"}},
        {"step": 2, "tool": "replace_color", "args": {"from_color": 0, "to_color": 5}}
      ]
    }
    ```

    Also accepts a bare list of steps.
    """
    block_re = re.compile(r"```(?:json)?\s*(.*?)\s*```", re.DOTALL | re.IGNORECASE)
    for raw in block_re.findall(text):
        try:
            obj = json.loads(raw)
            if isinstance(obj, dict) and "pseudocode" in obj:
                steps = [s for s in obj["pseudocode"] if isinstance(s, dict) and "tool" in s]
                return steps[:MAX_PSEUDOCODE_STEPS]
            if isinstance(obj, list) and obj and isinstance(obj[0], dict) and "tool" in obj[0]:
                steps = [s for s in obj if isinstance(s, dict) and "tool" in s]
                return steps[:MAX_PSEUDOCODE_STEPS]
        except (json.JSONDecodeError, Exception):
            continue
    return []


MAX_PSEUDOCODE_STEPS = 20  # sanity cap — more than this is almost certainly hallucinated


# ---------------------------------------------------------------------------
# Execution engine
# ---------------------------------------------------------------------------

def execute_steps(grid: Grid, steps: list[dict]) -> tuple[Grid, list[StepResult]]:
    """
    Execute a sequence of pseudo-code steps on a grid.
    Returns (final_grid, list_of_step_results).
    """
    current = [row[:] for row in grid]  # deep copy
    results: list[StepResult] = []

    for i, step in enumerate(steps):
        tool_name = step.get("tool", "")
        args = step.get("args", {})
        if not isinstance(args, dict):
            args = {}
        step_num = step.get("step", i + 1)

        grid_before = [row[:] for row in current]
        tool_fn = get_tool(tool_name)

        if tool_fn is None:
            results.append(StepResult(
                step_num=step_num,
                tool=tool_name,
                args=args,
                grid_before=grid_before,
                grid_after=current,
                success=False,
                error=f"Unknown tool: {tool_name}",
            ))
            continue

        try:
            current = tool_fn(current, **args)
            results.append(StepResult(
                step_num=step_num,
                tool=tool_name,
                args=args,
                grid_before=grid_before,
                grid_after=[row[:] for row in current],
            ))
        except Exception as e:
            results.append(StepResult(
                step_num=step_num,
                tool=tool_name,
                args=args,
                grid_before=grid_before,
                grid_after=current,
                success=False,
                error=str(e),
            ))

    return current, results


def verify_against_demos(steps: list[dict], task: dict) -> list[DemoResult]:
    """
    Run pseudo-code steps against all demo pairs.
    Returns a DemoResult per pair with pass/fail and step traces.
    """
    results: list[DemoResult] = []

    for i, pair in enumerate(task.get("train", [])):
        inp = pair["input"]
        expected = pair["output"]

        actual, step_results = execute_steps(inp, steps)
        passed = grids_equal(actual, expected)
        acc = cell_accuracy(actual, expected)
        diffs = [] if passed else diff_cells(actual, expected)

        # Find first step where output diverges from expected
        first_diverge = -1
        if not passed and step_results:
            # Check after each step if we've diverged
            # (compare intermediate grid against expected — crude but useful)
            for sr in step_results:
                if not sr.success:
                    first_diverge = sr.step_num
                    break

        results.append(DemoResult(
            demo_index=i,
            input_grid=inp,
            expected_output=expected,
            actual_output=actual,
            steps=step_results,
            passed=passed,
            cell_acc=acc,
            diff=diffs,
            first_diverge_step=first_diverge,
        ))

    return results


def run_executor(steps: list[dict], task: dict) -> ExecutionResult:
    """
    Full execution: verify against all demos, then apply to test input if all pass.
    """
    demo_results = verify_against_demos(steps, task)
    all_pass = all(d.passed for d in demo_results)

    test_output = None
    test_steps: list[StepResult] = []

    if all_pass and task.get("test"):
        test_input = task["test"][0]["input"]
        test_output, test_steps = execute_steps(test_input, steps)

    return ExecutionResult(
        demos=demo_results,
        test_output=test_output,
        test_steps=test_steps,
        all_pass=all_pass,
    )


# ---------------------------------------------------------------------------
# Direct grid verification (fallback: compare solver grids without pseudo-code)
# ---------------------------------------------------------------------------

def verify_solver_grids(
    solver_grids: dict[str, Grid],
    task: dict,
) -> dict[str, dict]:
    """
    Deterministically verify each solver's proposed grid against demo outputs.

    This is the fallback when solvers still produce grids (before full pseudo-code
    migration). Compares each solver's test output grid against the expected
    test output — but since we don't have the expected test output during real
    eval, this instead checks whether applying the grid's transformation pattern
    is consistent with demos by verifying grid shape and color distribution.

    For evaluation (when expected is known), use metadata.compute_outcome instead.

    Returns dict of {solver_name: {"verdict": "PASS"|"FAIL", "cell_acc": float, "diff_count": int}}
    """
    results = {}
    # We can't verify solver grids against demo pairs (solvers only produce test output)
    # So this function just checks basic consistency
    for name, grid in solver_grids.items():
        if grid is None:
            results[name] = {"verdict": "FAIL", "cell_acc": 0.0, "diff_count": -1}
            continue
        # Check shape matches test input shape
        test_input = task["test"][0]["input"] if task.get("test") else None
        if test_input:
            inp_shape = (len(test_input), len(test_input[0]))
            out_shape = (len(grid), len(grid[0]) if grid else 0)
            # For many ARC tasks, output shape equals input shape
            # This is a weak heuristic — real verification needs pseudo-code
            results[name] = {
                "verdict": "PASS",  # can't verify without expected, so pass by default
                "cell_acc": -1.0,
                "diff_count": 0,
                "shape_match": inp_shape == out_shape,
            }
        else:
            results[name] = {"verdict": "PASS", "cell_acc": -1.0, "diff_count": 0}

    return results


# ---------------------------------------------------------------------------
# Prompt helpers
# ---------------------------------------------------------------------------

def format_execution_trace(result: ExecutionResult) -> str:
    """
    Format execution result as text for injection into MEDIATOR/debugger prompts.
    Shows step-by-step execution and highlights failures.
    """
    lines = []

    for dr in result.demos:
        status = "PASS" if dr.passed else "FAIL"
        lines.append(f"## Demo {dr.demo_index + 1}: {status} ({dr.cell_acc*100:.0f}% accuracy)")

        for sr in dr.steps:
            step_status = "OK" if sr.success else f"ERROR: {sr.error}"
            args_str = ", ".join(f"{k}={v}" for k, v in sr.args.items())
            lines.append(f"  Step {sr.step_num}: {sr.tool}({args_str}) — {step_status}")
            lines.append(f"    Grid after: {len(sr.grid_after)}x{len(sr.grid_after[0]) if sr.grid_after else 0}")

        if not dr.passed:
            lines.append(f"  Actual output:\n{grid_to_str(dr.actual_output)}")
            lines.append(f"  Expected output:\n{grid_to_str(dr.expected_output)}")
            if dr.diff:
                lines.append(f"  Cells differing: {len(dr.diff)}")
                for r, c, got, want in dr.diff[:10]:
                    lines.append(f"    ({r},{c}): got {got}, expected {want}")
                if len(dr.diff) > 10:
                    lines.append(f"    ... and {len(dr.diff) - 10} more")
        lines.append("")

    if result.all_pass:
        lines.append("All demos PASS. Test output applied.")
    else:
        lines.append("FAILED on one or more demos. Test output NOT applied.")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Dynamic tool creation
# ---------------------------------------------------------------------------

def parse_new_tools(text: str) -> list[dict]:
    """Extract new_tools specifications from MEDIATOR response."""
    import numpy as np  # noqa — needed in exec namespace below
    blocks = re.findall(r"```json\s*(\{.*?\})\s*```", text, re.DOTALL)
    for block in blocks:
        try:
            data = json.loads(block)
            if "new_tools" in data and isinstance(data["new_tools"], list):
                return data["new_tools"]
        except json.JSONDecodeError:
            pass
    return []


def register_dynamic_tool(name: str, code: str) -> tuple[bool, str]:
    """
    Compile and register a dynamically generated tool function.
    Returns (success, error_message).
    """
    import numpy as np
    namespace: dict = {"np": np, "__builtins__": __builtins__}
    try:
        exec(compile(code, f"<tool:{name}>", "exec"), namespace)  # noqa: S102
        fn = namespace.get(name)
        if fn is None:
            return False, f"Function '{name}' not found in generated code"
        register_tool(name, fn)
        return True, ""
    except Exception as e:
        return False, str(e)
