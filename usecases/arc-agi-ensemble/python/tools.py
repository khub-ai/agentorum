"""
tools.py — Persistent tool registry for the ARC-AGI ensemble.

Generated Python tool code is stored in tools.json alongside rules.json.
On startup the executor re-registers every verified tool so the system
accumulates capabilities across puzzle runs without regenerating code.

Tool lifecycle:
  1. MEDIATOR requests a new tool by name in its pseudo-code
  2. _generate_and_register_tools() checks this registry first
  3. Cache hit  → re-register from saved code, skip generation (free)
  4. Cache miss → generate, verify against demos, register, then persist here
  5. Tools with verified=False are kept for debugging but never auto-loaded
"""

from __future__ import annotations
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional


# ---------------------------------------------------------------------------
# File locking (same pattern as rules.py)
# ---------------------------------------------------------------------------

def _acquire_lock(lock_path: Path, timeout: float = 15.0) -> bool:
    deadline = time.monotonic() + timeout
    while True:
        try:
            fd = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.close(fd)
            return True
        except FileExistsError:
            if time.monotonic() > deadline:
                return False
            time.sleep(0.05)

def _release_lock(lock_path: Path) -> None:
    try:
        os.unlink(str(lock_path))
    except OSError:
        pass


DEFAULT_PATH = Path(__file__).parent / "tools.json"


# ---------------------------------------------------------------------------
# ToolRegistry
# ---------------------------------------------------------------------------

class ToolRegistry:
    """Persistent store for LLM-generated grid transformation tools."""

    def __init__(self, path: str | Path | None = None):
        self.path = Path(path or os.environ.get("TOOLS_FILE", DEFAULT_PATH))
        self._data: dict[str, Any] = self._load()

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------

    def _load(self) -> dict[str, Any]:
        if self.path.exists():
            with open(self.path, "r", encoding="utf-8") as f:
                return json.load(f)
        return {"version": 1, "tools": []}

    def save(self) -> None:
        """Atomic merge-on-save with file locking (same pattern as RuleEngine)."""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        lock_path = self.path.with_suffix(".tools.lock")
        _acquire_lock(lock_path)
        try:
            disk: dict[str, Any] = self._load()
            disk_index: dict[str, int] = {t["name"]: i for i, t in enumerate(disk["tools"])}

            for tool in self._data["tools"]:
                if tool["name"] not in disk_index:
                    disk["tools"].append(tool)
                else:
                    # Prefer the in-memory copy (more recent / verified)
                    existing = disk["tools"][disk_index[tool["name"]]]
                    # Only overwrite if our copy is verified and theirs isn't,
                    # or our copy is newer
                    if tool.get("verified") or not existing.get("verified"):
                        disk["tools"][disk_index[tool["name"]]] = tool

            tmp = self.path.with_suffix(".tmp")
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(disk, f, indent=2)
            os.replace(tmp, self.path)
            self._data = disk
        finally:
            _release_lock(lock_path)

    def reload(self) -> None:
        self._data = self._load()

    # ------------------------------------------------------------------
    # Read
    # ------------------------------------------------------------------

    @property
    def tools(self) -> list[dict]:
        return self._data["tools"]

    def get(self, name: str) -> Optional[dict]:
        """Return a verified tool entry by name, or None."""
        for t in self.tools:
            if t["name"] == name and t.get("verified", False):
                return t
        return None

    def verified_tools(self) -> list[dict]:
        return [t for t in self.tools if t.get("verified", False)]

    def stats_summary(self) -> dict[str, Any]:
        total = len(self.tools)
        verified = len(self.verified_tools())
        return {"total": total, "verified": verified, "failed": total - verified}

    # ------------------------------------------------------------------
    # Write
    # ------------------------------------------------------------------

    def _now_iso(self) -> str:
        return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")

    def register(
        self,
        name: str,
        code: str,
        verified: bool,
        source_task: str = "",
        description: str = "",
        fix_attempts: int = 0,
    ) -> None:
        """Add or update a tool entry and persist to disk."""
        entry = {
            "name": name,
            "code": code,
            "verified": verified,
            "source_task": source_task,
            "description": description,
            "fix_attempts": fix_attempts,
            "created": self._now_iso(),
        }
        # Update in-memory
        for i, t in enumerate(self._data["tools"]):
            if t["name"] == name:
                # Only overwrite unverified entries with verified ones
                if verified or not t.get("verified"):
                    self._data["tools"][i] = entry
                return
        self._data["tools"].append(entry)
        self.save()

    # ------------------------------------------------------------------
    # Executor integration
    # ------------------------------------------------------------------

    def load_into_executor(self) -> list[str]:
        """
        Re-register all verified tools into the executor's in-memory registry.
        Called at harness startup to restore tools from previous sessions.
        Returns list of tool names successfully loaded.
        """
        from executor import register_dynamic_tool
        loaded = []
        for tool in self.verified_tools():
            ok, err = register_dynamic_tool(tool["name"], tool["code"])
            if ok:
                loaded.append(tool["name"])
        return loaded

    # ------------------------------------------------------------------
    # Prompt helpers
    # ------------------------------------------------------------------

    def build_tool_section_for_prompt(self) -> str:
        """
        Returns a prompt section listing all verified tools for the MEDIATOR,
        so it can request them by name without triggering re-generation.
        """
        tools = self.verified_tools()
        if not tools:
            return ""
        lines = [
            "## Available Generated Tools",
            "These tools are already registered and can be used directly in pseudo-code.",
            "Prefer reusing an existing tool over requesting a new one if it fits.\n",
        ]
        for t in tools:
            desc = t.get("description", "").strip()
            desc_str = f" — {desc}" if desc else ""
            lines.append(f"- `{t['name']}(grid, **kwargs)`{desc_str}  *(from task {t.get('source_task', '?')})*")
        return "\n".join(lines)
