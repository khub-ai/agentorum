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

def _find_components(grid: Grid, background: int = 0) -> list[dict]:
    """
    Return all 4-connected components of non-background cells.
    Each component dict has: cells (list of (r,c)), color, top, bottom, left, right.
    """
    from collections import deque
    arr = to_np(grid)
    rows, cols = arr.shape
    visited = np.zeros((rows, cols), dtype=bool)
    components: list[dict] = []

    for r in range(rows):
        for c in range(cols):
            v = int(arr[r, c])
            if v != background and not visited[r, c]:
                cells: list[tuple[int, int]] = []
                q: deque[tuple[int, int]] = deque([(r, c)])
                visited[r, c] = True
                while q:
                    cr, cc = q.popleft()
                    cells.append((cr, cc))
                    for nr, nc in ((cr+1,cc),(cr-1,cc),(cr,cc+1),(cr,cc-1)):
                        if 0 <= nr < rows and 0 <= nc < cols and not visited[nr,nc] and int(arr[nr,nc]) == v:
                            visited[nr,nc] = True
                            q.append((nr, nc))
                rs = [x[0] for x in cells]
                cs = [x[1] for x in cells]
                components.append({
                    "cells": cells, "color": v,
                    "top": min(rs), "bottom": max(rs),
                    "left": min(cs), "right": max(cs),
                })
    return components


def _is_closed_hollow_rect(comp: dict) -> bool:
    """
    True if the component is a closed hollow rectangle:
    - Bounding box at least 3×3
    - All perimeter cells of bounding box filled, all interior cells empty
    """
    t, b, l, r = comp["top"], comp["bottom"], comp["left"], comp["right"]
    h, w = b - t + 1, r - l + 1
    if h < 3 or w < 3:
        return False
    expected = 2 * (h + w) - 4  # perimeter cell count
    if len(comp["cells"]) != expected:
        return False
    cells_set = set(comp["cells"])
    for row in range(t, b + 1):
        for col in range(l, r + 1):
            on_perim = (row == t or row == b or col == l or col == r)
            in_set = (row, col) in cells_set
            if on_perim != in_set:
                return False
    return True


def gravity_by_type(
    grid: Grid,
    background: int = 0,
    **kwargs,
) -> Grid:
    """
    Type-classified gravity: closed hollow rectangles float UP, open/cross shapes sink DOWN.

    Classification:
      - Closed hollow rectangle: bounding box ≥ 3×3, all perimeter cells filled,
        all interior cells background.
      - Open/cross shape: everything else (plus, T, L, incomplete frame, solid, etc.)

    Movement rules:
      - Each object slides as a rigid unit (all cells shift by the same row delta).
      - Object color is preserved.
      - Closed rects stack from row 0 downward (sorted by original top row).
      - Open shapes stack from last row upward (sorted by original bottom row).
      - Different-type objects pass through each other freely.
      - Same-type objects maintain original relative vertical order (no overlap).
    """
    arr = to_np(grid)
    rows, cols = arr.shape

    components = _find_components(grid, background=background)
    for comp in components:
        comp["type"] = "closed_rect" if _is_closed_hollow_rect(comp) else "open_shape"

    result = np.zeros_like(arr)

    # --- Stack closed rects from top ---
    closed = sorted(
        [c for c in components if c["type"] == "closed_rect"],
        key=lambda x: x["top"],
    )
    col_top = [0] * cols  # next free row from top, per column

    for comp in closed:
        # new_top = highest row index such that no cell of the placed object
        # overlaps with already-placed cells (respects col_top per column).
        # For cell (cr, cc): placed row = new_top + (cr - comp["top"])
        # Constraint: new_top + (cr - comp["top"]) >= col_top[cc]
        # => new_top >= col_top[cc] - (cr - comp["top"])
        new_top = max(
            (col_top[cc] - (cr - comp["top"]) for (cr, cc) in comp["cells"]),
            default=0,
        )
        new_top = max(new_top, 0)
        delta = new_top - comp["top"]
        for (cr, cc) in comp["cells"]:
            result[cr + delta, cc] = comp["color"]
        for (cr, cc) in comp["cells"]:
            col_top[cc] = max(col_top[cc], cr + delta + 1)

    # --- Stack open shapes from bottom ---
    open_shapes = sorted(
        [c for c in components if c["type"] == "open_shape"],
        key=lambda x: -x["bottom"],
    )
    col_bot = [rows - 1] * cols  # next free row from bottom, per column

    for comp in open_shapes:
        # new_bottom = lowest row index such that no cell overlaps already-placed.
        # For cell (cr, cc): placed row = new_bottom - (comp["bottom"] - cr)
        # Constraint: new_bottom - (comp["bottom"] - cr) <= col_bot[cc]
        # => new_bottom <= col_bot[cc] + (comp["bottom"] - cr)
        new_bottom = min(
            (col_bot[cc] + (comp["bottom"] - cr) for (cr, cc) in comp["cells"]),
            default=rows - 1,
        )
        new_bottom = min(new_bottom, rows - 1)
        delta = new_bottom - comp["bottom"]
        for (cr, cc) in comp["cells"]:
            result[cr + delta, cc] = comp["color"]
        for (cr, cc) in comp["cells"]:
            col_bot[cc] = min(col_bot[cc], cr + delta - 1)

    return to_list(result)


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


def barrier_beam(grid: Grid, background: int = 0, **kwargs) -> Grid:
    """
    8-barrier (full row or column) divides the grid into a 4-side and a 2-side.
    For each row/col that contains 4-cells:
      1. Original 4 positions → 3 (shadow marker)
      2. Fill between 4s and barrier with 4 (shoot toward barrier)
      3. Pack the 2-cells for that row/col flush against the FAR EDGE,
         fill between barrier and packed 2s with 8
    Rows/cols with no 4s are unchanged.
    Works for both vertical and horizontal barriers, and for 4s on either side.
    """
    rows = len(grid)
    cols = len(grid[0]) if rows else 0
    result = [row[:] for row in grid]

    full_col_8 = [c for c in range(cols) if all(grid[r][c] == 8 for r in range(rows))]
    full_row_8 = [r for r in range(rows) if all(grid[r][c] == 8 for c in range(cols))]

    if full_col_8:
        barrier = full_col_8[0]
        four_left = any(grid[r][c] == 4 for r in range(rows) for c in range(barrier))
        for r in range(rows):
            if four_left:
                fours = [c for c in range(barrier) if grid[r][c] == 4]
                twos  = [c for c in range(barrier + 1, cols) if grid[r][c] == 2]
                if not fours:
                    continue
                for c in fours:
                    result[r][c] = 3
                for c in range(max(fours) + 1, barrier):
                    result[r][c] = 4
                pack = cols - len(twos)
                for c in range(barrier + 1, pack):
                    result[r][c] = 8
                for i in range(len(twos)):
                    result[r][pack + i] = 2
            else:
                fours = [c for c in range(barrier + 1, cols) if grid[r][c] == 4]
                twos  = [c for c in range(barrier) if grid[r][c] == 2]
                if not fours:
                    continue
                for c in fours:
                    result[r][c] = 3
                for c in range(barrier + 1, min(fours)):
                    result[r][c] = 4
                pack = len(twos)
                for c in range(pack, barrier):
                    result[r][c] = 8
                for i in range(len(twos)):
                    result[r][i] = 2

    elif full_row_8:
        barrier = full_row_8[0]
        four_above = any(grid[r][c] == 4 for r in range(barrier) for c in range(cols))
        for c in range(cols):
            if four_above:
                fours = [r for r in range(barrier) if grid[r][c] == 4]
                twos  = [r for r in range(barrier + 1, rows) if grid[r][c] == 2]
                if not fours:
                    continue
                for r in fours:
                    result[r][c] = 3
                for r in range(max(fours) + 1, barrier):
                    result[r][c] = 4
                pack = rows - len(twos)
                for r in range(barrier + 1, pack):
                    result[r][c] = 8
                for i in range(len(twos)):
                    result[pack + i][c] = 2
            else:
                fours = [r for r in range(barrier + 1, rows) if grid[r][c] == 4]
                twos  = [r for r in range(barrier) if grid[r][c] == 2]
                if not fours:
                    continue
                for r in fours:
                    result[r][c] = 3
                for r in range(barrier + 1, min(fours)):
                    result[r][c] = 4
                pack = len(twos)
                for r in range(pack, barrier):
                    result[r][c] = 8
                for i in range(len(twos)):
                    result[i][c] = 2

    return result


def draw_lines_and_replace_intersecting_rects(
    grid: Grid, line_color: int = 1, rect_color: int = 2, **kwargs
) -> Grid:
    """
    1-markers on opposite edges define lines; convert adjacent/intersecting
    2-rectangles to 1s and draw the full lines.

    Line detection (opposite-edge pairing only):
    - Horizontal line at row R: markers at (R, 0) AND (R, ncols-1)
    - Vertical line at col C:   markers at (0, C) AND (nrows-1, C)

    Conversion rule: a connected rect_color component is converted entirely
    to line_color if ANY line row r satisfies r0-1 <= r <= r1+1, OR any
    line col c satisfies c0-1 <= c <= c1+1 (adjacent counts, not just
    passing through).
    """
    from collections import deque
    rows = len(grid)
    cols = len(grid[0]) if rows else 0
    if not rows or not cols:
        return [row[:] for row in grid]

    lc = kwargs.get('line_color', line_color)
    rc = kwargs.get('rect_color', rect_color)

    # Collect marker positions
    by_row = {}
    by_col = {}
    for r in range(rows):
        for c in range(cols):
            if grid[r][c] == lc:
                by_row.setdefault(r, set()).add(c)
                by_col.setdefault(c, set()).add(r)

    # Opposite-edge pairing
    h_lines = {r for r, cs in by_row.items() if 0 in cs and cols - 1 in cs}
    v_lines = {c for c, rs in by_col.items() if 0 in rs and rows - 1 in rs}

    # Find connected components of rect_color
    visited = [[False] * cols for _ in range(rows)]
    components = []
    for r0 in range(rows):
        for c0 in range(cols):
            if grid[r0][c0] == rc and not visited[r0][c0]:
                comp = []
                q = deque([(r0, c0)])
                visited[r0][c0] = True
                while q:
                    cr, cc = q.popleft()
                    comp.append((cr, cc))
                    for dr, dc in [(-1,0),(1,0),(0,-1),(0,1)]:
                        nr, nc = cr+dr, cc+dc
                        if 0<=nr<rows and 0<=nc<cols and not visited[nr][nc] and grid[nr][nc]==rc:
                            visited[nr][nc] = True
                            q.append((nr, nc))
                rs = [x for x, _ in comp]; cs2 = [x for _, x in comp]
                components.append((comp, min(rs), max(rs), min(cs2), max(cs2)))

    # Determine which components to convert (within 1 cell of any line)
    convert = set()
    for comp, rmin, rmax, cmin, cmax in components:
        if (any(rmin-1 <= lr <= rmax+1 for lr in h_lines) or
                any(cmin-1 <= lc2 <= cmax+1 for lc2 in v_lines)):
            for cell in comp:
                convert.add(cell)

    # Build output
    result = [row[:] for row in grid]
    for r in h_lines:
        for c in range(cols):
            result[r][c] = lc
    for c in v_lines:
        for r in range(rows):
            result[r][c] = lc
    for r, c in convert:
        result[r][c] = lc
    return result


def unshear_right(grid: Grid, background: int = 0, **kwargs) -> Grid:
    """
    One-step de-shear: for each color group, keep the bottom row fixed
    and shift every cell in every other row right by 1, capped at the
    group's max right column (min(col + 1, max_right)).

    Groups by color (not 4-connectivity) because sheared shapes are
    diagonally connected, not orthogonally connected.
    """
    from collections import defaultdict
    rows = len(grid)
    cols = len(grid[0]) if rows else 0

    color_cells: dict = defaultdict(list)
    for r in range(rows):
        for c in range(cols):
            v = grid[r][c]
            if v != background:
                color_cells[v].append((r, c))

    result = [[background] * cols for _ in range(rows)]

    for color, cells in color_cells.items():
        bottom_row = max(r for r, _ in cells)
        max_right = max(c for _, c in cells)
        for r, c in cells:
            if r == bottom_row:
                result[r][c] = color
            else:
                result[r][min(c + 1, max_right)] = color

    return result


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
