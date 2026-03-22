"""
grid_tools.py — Numpy-based grid operations for ARC-AGI puzzles.

All functions accept/return plain Python lists (List[List[int]]) so they
interoperate cleanly with JSON. Numpy is used only internally.
"""

from __future__ import annotations
import numpy as np
from typing import List, Tuple, Optional


# ---------------------------------------------------------------------------
# Type alias
# ---------------------------------------------------------------------------
Grid = List[List[int]]


# ---------------------------------------------------------------------------
# Conversion helpers
# ---------------------------------------------------------------------------

def to_np(grid: Grid) -> np.ndarray:
    return np.array(grid, dtype=np.int32)

def to_list(arr: np.ndarray) -> Grid:
    return arr.tolist()


# ---------------------------------------------------------------------------
# Basic properties
# ---------------------------------------------------------------------------

def shape(grid: Grid) -> Tuple[int, int]:
    arr = to_np(grid)
    return arr.shape  # (rows, cols)

def unique_colors(grid: Grid) -> List[int]:
    return sorted(set(np.unique(to_np(grid)).tolist()))

def color_count(grid: Grid, color: int) -> int:
    return int(np.sum(to_np(grid) == color))

def bounding_box(grid: Grid, color: int) -> Optional[Tuple[int, int, int, int]]:
    """Return (row_min, col_min, row_max, col_max) for all cells of `color`."""
    arr = to_np(grid)
    rows, cols = np.where(arr == color)
    if len(rows) == 0:
        return None
    return int(rows.min()), int(cols.min()), int(rows.max()), int(cols.max())


# ---------------------------------------------------------------------------
# Transformations
# ---------------------------------------------------------------------------

def rotate_90(grid: Grid, k: int = 1) -> Grid:
    """Rotate counter-clockwise by 90*k degrees."""
    return to_list(np.rot90(to_np(grid), k))

def flip_horizontal(grid: Grid) -> Grid:
    return to_list(np.fliplr(to_np(grid)))

def flip_vertical(grid: Grid) -> Grid:
    return to_list(np.flipud(to_np(grid)))

def transpose(grid: Grid) -> Grid:
    return to_list(to_np(grid).T)

def crop(grid: Grid, row_start: int, col_start: int, row_end: int, col_end: int) -> Grid:
    """Crop to [row_start:row_end, col_start:col_end] (exclusive end)."""
    return to_list(to_np(grid)[row_start:row_end, col_start:col_end])

def pad(grid: Grid, top: int = 0, bottom: int = 0, left: int = 0, right: int = 0, fill: int = 0) -> Grid:
    return to_list(np.pad(to_np(grid), ((top, bottom), (left, right)), constant_values=fill))

def replace_color(grid: Grid, from_color: int, to_color: int) -> Grid:
    arr = to_np(grid).copy()
    arr[arr == from_color] = to_color
    return to_list(arr)

def apply_gravity(grid: Grid, direction: str = "down", background: int = 0) -> Grid:
    """
    Slide non-background cells in `direction` ('down', 'up', 'left', 'right').
    Works column-wise for down/up, row-wise for left/right.
    """
    arr = to_np(grid).copy()
    rows, cols = arr.shape

    if direction in ("down", "up"):
        for c in range(cols):
            col = arr[:, c]
            non_bg = col[col != background]
            n = len(non_bg)
            if direction == "down":
                arr[:, c] = np.array([background] * (rows - n) + list(non_bg))
            else:
                arr[:, c] = np.array(list(non_bg) + [background] * (rows - n))
    else:
        for r in range(rows):
            row = arr[r, :]
            non_bg = row[row != background]
            n = len(non_bg)
            if direction == "right":
                arr[r, :] = np.array([background] * (cols - n) + list(non_bg))
            else:
                arr[r, :] = np.array(list(non_bg) + [background] * (cols - n))

    return to_list(arr)

def flood_fill(grid: Grid, start_row: int, start_col: int, fill_color: int) -> Grid:
    """BFS flood fill from (start_row, start_col)."""
    arr = to_np(grid).copy()
    target = int(arr[start_row, start_col])
    if target == fill_color:
        return to_list(arr)
    rows, cols = arr.shape
    stack = [(start_row, start_col)]
    while stack:
        r, c = stack.pop()
        if r < 0 or r >= rows or c < 0 or c >= cols:
            continue
        if arr[r, c] != target:
            continue
        arr[r, c] = fill_color
        stack.extend([(r+1,c),(r-1,c),(r,c+1),(r,c-1)])
    return to_list(arr)

def count_connected_components(grid: Grid, color: int) -> int:
    """Count 4-connected components of the given color."""
    arr = to_np(grid).copy()
    rows, cols = arr.shape
    visited = np.zeros_like(arr, dtype=bool)
    count = 0
    for r in range(rows):
        for c in range(cols):
            if arr[r, c] == color and not visited[r, c]:
                count += 1
                stack = [(r, c)]
                while stack:
                    cr, cc = stack.pop()
                    if cr < 0 or cr >= rows or cc < 0 or cc >= cols:
                        continue
                    if visited[cr, cc] or arr[cr, cc] != color:
                        continue
                    visited[cr, cc] = True
                    stack.extend([(cr+1,cc),(cr-1,cc),(cr,cc+1),(cr,cc-1)])
    return count


# ---------------------------------------------------------------------------
# Comparison
# ---------------------------------------------------------------------------

def grids_equal(a: Grid, b: Grid) -> bool:
    if not a or not b:
        return False
    try:
        return np.array_equal(to_np(a), to_np(b))
    except Exception:
        return False

def diff_cells(a: Grid, b: Grid) -> List[Tuple[int, int, int, int]]:
    """Return list of (row, col, val_a, val_b) for cells that differ."""
    arr_a, arr_b = to_np(a), to_np(b)
    if arr_a.shape != arr_b.shape:
        return [(-1, -1, -1, -1)]
    rows, cols = np.where(arr_a != arr_b)
    result = []
    for r, c in zip(rows.tolist(), cols.tolist()):
        result.append((r, c, int(arr_a[r, c]), int(arr_b[r, c])))
    return result

def cell_accuracy(predicted: Grid, expected: Grid) -> float:
    """Fraction of cells that are correct (0.0–1.0). Returns 0.0 on shape mismatch."""
    try:
        arr_p, arr_e = to_np(predicted), to_np(expected)
        if arr_p.shape != arr_e.shape:
            return 0.0
        total = arr_p.size
        correct = int(np.sum(arr_p == arr_e))
        return correct / total if total > 0 else 1.0
    except Exception:
        return 0.0


# ---------------------------------------------------------------------------
# Display
# ---------------------------------------------------------------------------

# ARC-AGI color palette (index → name)
COLOR_NAMES = {
    0: "black", 1: "blue", 2: "red", 3: "green", 4: "yellow",
    5: "gray", 6: "magenta", 7: "orange", 8: "azure", 9: "maroon"
}

# ANSI color codes for terminal rendering
_ANSI = {
    0: "\033[40m",   # black bg
    1: "\033[44m",   # blue bg
    2: "\033[41m",   # red bg
    3: "\033[42m",   # green bg
    4: "\033[43m",   # yellow bg
    5: "\033[47m",   # white/gray bg
    6: "\033[45m",   # magenta bg
    7: "\033[43m",   # orange → yellow
    8: "\033[46m",   # azure/cyan bg
    9: "\033[41m",   # maroon → red
}
_RESET = "\033[0m"

def grid_to_str(grid: Grid, use_ansi: bool = False) -> str:
    """Compact string representation of a grid."""
    lines = []
    for row in grid:
        if use_ansi:
            lines.append("".join(f"{_ANSI.get(c, '')} {c} {_RESET}" for c in row))
        else:
            lines.append(" ".join(str(c) for c in row))
    return "\n".join(lines)

def summarize(grid: Grid) -> str:
    """One-line summary: shape + color distribution."""
    if not grid:
        return "(empty)"
    r, c = shape(grid)
    dist = {col: color_count(grid, col) for col in unique_colors(grid)}
    dist_str = ", ".join(f"{COLOR_NAMES.get(k, k)}={v}" for k, v in sorted(dist.items()))
    return f"{r}×{c}  [{dist_str}]"
