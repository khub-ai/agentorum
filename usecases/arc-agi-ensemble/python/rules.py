"""
rules.py — Production rule system for the ARC-AGI ensemble.

Each rule has a natural-language condition (identifies puzzle type) and action
(guidance for solving). Rules accumulate across puzzle runs, forming a growing
knowledge base that improves ensemble performance over time.

Rule lifecycle:
  1. New puzzle arrives → match conditions against demo pairs (one LLM call)
  2. Top-ranked matching rules fire → their actions are injected into agent prompts
  3. After solving:
     - Success → fired rules get stats.succeeded++
     - Failure → fired rules get stats.failed++
     - MEDIATOR may generalize/specialize rules or create new ones

Rule lineage tracks how each rule was created (from scratch, generalized, or
specialized from a parent), forming a derivation tree.
"""

from __future__ import annotations
import json
import os
import re
import time
from datetime import datetime, timezone
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional


# ---------------------------------------------------------------------------
# File locking (cross-platform, no external deps)
# ---------------------------------------------------------------------------

def _acquire_lock(lock_path: Path, timeout: float = 15.0) -> bool:
    """Spin-acquire an exclusive lock file. Returns True on success."""
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

DEFAULT_PATH = Path(__file__).parent / "rules.json"


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------

@dataclass
class RuleMatch:
    """Result of evaluating a single rule's condition against a puzzle."""
    rule_id: str
    confidence: str          # "high" | "medium" | "low"
    score: float             # 0.0–1.0 combined (match_conf × success_rate)
    rule: dict               # the full rule dict


@dataclass
class FiringResult:
    """Outcome of firing rules on a task."""
    task_id: str
    matched: list[RuleMatch]
    injected_ids: list[str]   # IDs of rules whose actions were injected


# ---------------------------------------------------------------------------
# Rule engine
# ---------------------------------------------------------------------------

class RuleEngine:
    def __init__(self, path: str | Path | None = None):
        self.path = Path(path or os.environ.get("RULES_FILE", DEFAULT_PATH))
        self._data: dict[str, Any] = self._load()

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------

    def _load(self) -> dict[str, Any]:
        if self.path.exists():
            with open(self.path, "r", encoding="utf-8") as f:
                return json.load(f)
        return {"version": 2, "rules": []}

    def save(self) -> None:
        """Write rules to disk with file locking and merge-on-save.

        Concurrent processes each hold their own in-memory state. On save:
        1. Acquire exclusive lock
        2. Re-read current disk state (may have rules added by other processes)
        3. Merge: add any rules we have that disk doesn't, update stats for shared rules
        4. Atomic write (temp file + os.replace)
        5. Update our in-memory state to the merged result
        """
        self.path.parent.mkdir(parents=True, exist_ok=True)
        lock_path = self.path.with_suffix(".lock")
        _acquire_lock(lock_path)
        try:
            # Re-read disk to pick up concurrent writes
            disk: dict[str, Any] = self._load()
            disk_index: dict[str, int] = {r["id"]: i for i, r in enumerate(disk["rules"])}

            for rule in self.rules:
                if rule["id"] not in disk_index:
                    # New rule we created — append it
                    disk["rules"].append(rule)
                else:
                    # Rule exists on disk — our in-memory copy has the freshest stats
                    disk["rules"][disk_index[rule["id"]]] = rule

            # Atomic write: write to .tmp then rename
            tmp = self.path.with_suffix(".tmp")
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(disk, f, indent=2)
            os.replace(tmp, self.path)

            # Sync our in-memory state to what we wrote
            self._data = disk
        finally:
            _release_lock(lock_path)

    def reload(self) -> None:
        self._data = self._load()

    # ------------------------------------------------------------------
    # Read
    # ------------------------------------------------------------------

    @property
    def rules(self) -> list[dict]:
        return self._data["rules"]

    def get(self, rule_id: str) -> Optional[dict]:
        for r in self.rules:
            if r["id"] == rule_id:
                return r
        return None

    def active_rules(self) -> list[dict]:
        """Return all rules that are not deprecated (both task and preference types).
        Includes 'active' and 'candidate' rules."""
        return [r for r in self.rules if r.get("status", "active") in ("active", "candidate")]

    def active_task_rules(self) -> list[dict]:
        """Return active + candidate task rules (matched per-puzzle in Round 0)."""
        return [r for r in self.active_rules() if r.get("rule_type", "task") == "task"]

    def active_preference_rules(self) -> list[dict]:
        """Return active preference rules (soft priors injected for every puzzle)."""
        return [r for r in self.active_rules() if r.get("rule_type") == "preference"]

    def candidate_rules(self) -> list[dict]:
        """Return candidate rules (generalized; awaiting first independent confirmation)."""
        return [r for r in self.rules if r.get("status") == "candidate"]

    def stats_summary(self) -> dict[str, Any]:
        all_rules = self.rules
        total = len(all_rules)
        confirmed = [r for r in all_rules if r.get("status", "active") == "active"]
        candidates = self.candidate_rules()
        deprecated = [r for r in all_rules if r.get("status") == "deprecated"]
        fired = sum(r["stats"]["fired"] for r in confirmed + candidates)
        succeeded = sum(r["stats"]["succeeded"] for r in confirmed + candidates)
        return {
            "total": total,
            "active": len(confirmed),
            "candidates": len(candidates),
            "deprecated": len(deprecated),
            "total_fired": fired,
            "total_succeeded": succeeded,
        }

    # ------------------------------------------------------------------
    # Create
    # ------------------------------------------------------------------

    def _next_id(self) -> str:
        if not self.rules:
            return "r_001"
        nums = []
        for r in self.rules:
            try:
                nums.append(int(r["id"].split("_")[1]))
            except (ValueError, IndexError):
                pass
        return f"r_{(max(nums) + 1 if nums else 1):03d}"

    def _now_iso(self) -> str:
        return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")

    def add_rule(
        self,
        condition: str,
        action: str,
        source: str = "mediator",
        source_task: str = "",
        tags: list[str] | None = None,
        lineage: dict | None = None,
        rule_type: str = "task",
        status: str = "active",
    ) -> dict:
        """
        Create a new rule and persist it.

        Args:
            condition:   Natural language condition (identifies puzzle type)
            action:      Natural language action (guidance for solving)
            source:      Who created this rule: "mediator", "human", "system"
            source_task: Task ID that triggered creation
            tags:        Optional category tags
            lineage:     Optional derivation info:
                         {"type": "new" | "generalized" | "specialized" | "merged",
                          "parent_ids": ["r_001", ...],
                          "reason": "why this derivation was needed"}
            rule_type:   "task" (default) or "preference".
                         - "task" rules encode how to solve a category of puzzle.
                           They are matched per-puzzle in Round 0 and injected as prior
                           knowledge when the condition matches.
                         - "preference" rules encode *which hypothesis property to prefer*
                           when multiple plausible hypotheses exist. They are learned from
                           correction events (wrong hypothesis → human insight → success)
                           and injected as soft priors for every puzzle regardless of match.
            status:      "active" (default), "candidate", or "deprecated".
                         - "active": fully vetted; used in Round 0 matching.
                         - "candidate": generalized/inferred; included in matching but
                           labeled as unconfirmed. Promoted to "active" on first independent
                           success. Deprecated after 1 failure on an unrelated task.
                         - "deprecated": excluded from all matching.

        Returns:
            The newly created rule dict.
        """
        rule = {
            "id": self._next_id(),
            "condition": condition,
            "action": action,
            "rule_type": rule_type,
            "stats": {"fired": 0, "succeeded": 0, "failed": 0},
            "source": source,
            "source_task": source_task,
            "tags": tags or [],
            "lineage": lineage or {"type": "new", "parent_ids": [], "reason": ""},
            "status": status,
            "created": self._now_iso(),
            "last_fired": None,
        }
        self.rules.append(rule)
        self.save()
        return rule

    def generalize_rule(
        self,
        parent_id: str,
        new_condition: str,
        new_action: str,
        reason: str,
        source_task: str = "",
        tags: list[str] | None = None,
    ) -> dict:
        """Create a more general rule derived from an existing one.

        Starts as 'candidate' — promoted to 'active' on first independent success.
        """
        parent = self.get(parent_id)
        merged_tags = list(set((tags or []) + (parent.get("tags", []) if parent else [])))
        return self.add_rule(
            condition=new_condition,
            action=new_action,
            source="mediator",
            source_task=source_task,
            tags=merged_tags,
            lineage={
                "type": "generalized",
                "parent_ids": [parent_id],
                "reason": reason,
            },
            status="candidate",
        )

    def specialize_rule(
        self,
        parent_id: str,
        new_condition: str,
        new_action: str,
        reason: str,
        source_task: str = "",
        tags: list[str] | None = None,
    ) -> dict:
        """Create a more specific rule derived from an existing one."""
        parent = self.get(parent_id)
        merged_tags = list(set((tags or []) + (parent.get("tags", []) if parent else [])))
        return self.add_rule(
            condition=new_condition,
            action=new_action,
            source="mediator",
            source_task=source_task,
            tags=merged_tags,
            lineage={
                "type": "specialized",
                "parent_ids": [parent_id],
                "reason": reason,
            },
        )

    def merge_rules(
        self,
        parent_ids: list[str],
        new_condition: str,
        new_action: str,
        reason: str,
        source_task: str = "",
        tags: list[str] | None = None,
    ) -> dict:
        """Create a rule that combines insights from multiple parent rules."""
        all_tags = list(tags or [])
        for pid in parent_ids:
            p = self.get(pid)
            if p:
                all_tags.extend(p.get("tags", []))
        return self.add_rule(
            condition=new_condition,
            action=new_action,
            source="mediator",
            source_task=source_task,
            tags=list(set(all_tags)),
            lineage={
                "type": "merged",
                "parent_ids": parent_ids,
                "reason": reason,
            },
        )

    # ------------------------------------------------------------------
    # Update
    # ------------------------------------------------------------------

    def record_success(self, rule_id: str, task_id: str) -> None:
        r = self.get(rule_id)
        if r:
            r["stats"]["fired"] += 1
            r["stats"]["succeeded"] += 1
            r["last_fired"] = self._now_iso()
            self.save()

    def record_failure(self, rule_id: str, task_id: str) -> None:
        r = self.get(rule_id)
        if r:
            r["stats"]["fired"] += 1
            r["stats"]["failed"] += 1
            r["last_fired"] = self._now_iso()
            self.save()

    def deprecate_rule(self, rule_id: str, reason: str = "") -> None:
        r = self.get(rule_id)
        if r:
            r["status"] = "deprecated"
            r["deprecated_reason"] = reason
            self.save()

    def reactivate_rule(self, rule_id: str) -> None:
        r = self.get(rule_id)
        if r:
            r["status"] = "active"
            r.pop("deprecated_reason", None)
            self.save()

    def promote_candidate(self, rule_id: str) -> bool:
        """Promote a candidate rule to active after its first independent success.

        Returns True if promoted, False if rule not found or not a candidate.
        """
        r = self.get(rule_id)
        if r and r.get("status") == "candidate":
            r["status"] = "active"
            self.save()
            return True
        return False

    def auto_deprecate(self, min_fired: int = 3) -> list[str]:
        """Deprecate rules that have been fired but never succeeded.

        Active rules: deprecated after min_fired failures with 0 successes.
        Candidate rules: deprecated after just 1 failure (they haven't been
        confirmed yet, so a failure is strong evidence the generalization is wrong).

        Returns list of deprecated rule IDs.
        """
        deprecated = []
        for r in self.active_rules():
            s = r["stats"]
            is_candidate = r.get("status") == "candidate"
            threshold = 1 if is_candidate else min_fired
            if s["fired"] >= threshold and s["succeeded"] == 0:
                self.deprecate_rule(r["id"], reason=f"auto: fired {s['fired']}x, 0 successes (candidate={is_candidate})")
                deprecated.append(r["id"])
        return deprecated

    def edit_rule(self, rule_id: str, condition: str = "", action: str = "") -> None:
        """Human-driven edit of a rule's condition or action."""
        r = self.get(rule_id)
        if r:
            if condition:
                r["condition"] = condition
            if action:
                r["action"] = action
            self.save()

    # ------------------------------------------------------------------
    # Match (LLM-based)
    # ------------------------------------------------------------------

    def format_rules_for_matching(self) -> str:
        """
        Build a prompt fragment listing active task rules for the LLM to evaluate.
        Only task rules are matched per-puzzle; preference rules are applied globally.
        Returns a numbered list the LLM can reference by ID.
        """
        active = self.active_task_rules()
        if not active:
            return "(no rules in the rule base)"
        lines = []
        for r in active:
            sr = self._success_rate(r)
            label = " ⚠ CANDIDATE (unconfirmed generalization)" if r.get("status") == "candidate" else ""
            lines.append(
                f"- [{r['id']}]{label} (success {sr:.0%}, fired {r['stats']['fired']}x)\n"
                f"  CONDITION: {r['condition']}\n"
                f"  ACTION: {r['action']}"
            )
        return "\n".join(lines)

    def format_preference_rules_for_solver(self) -> str:
        """
        Build a prompt section listing preference rules as soft priors for solvers.

        Preference rules are learned from correction events: when a solver's initial
        hypothesis was wrong, a human provided an insight, and the corrected approach
        succeeded. They encode *which hypothesis property to prefer* when multiple
        plausible interpretations exist — not how to solve a specific puzzle type.

        Returned section is injected into every solver prompt regardless of puzzle match.
        Solvers are explicitly told these are suggestions, not mandates.
        """
        prefs = self.active_preference_rules()
        if not prefs:
            return ""
        lines = [
            "## Reasoning Preferences (soft priors — treat as suggestions, not rules)",
            "The system has learned these preferences from past correction events.",
            "When multiple hypotheses seem equally valid based on demos alone, prefer the one",
            "that aligns with these priors. Demo evidence always overrides a prior.\n",
        ]
        for r in prefs:
            lines.append(f"- **[{r['id']}]** {r['action']}")
            if r.get("source_task"):
                lines.append(f"  *(learned from task {r['source_task']})*")
        return "\n".join(lines)

    def format_fired_rules_for_prompt(self, matches: list[RuleMatch],
                                       max_rules: int = 5) -> str:
        """
        Build a prompt section with the top-N fired rules' actions,
        suitable for injection into solver/MEDIATOR prompts.
        """
        top = sorted(matches, key=lambda m: m.score, reverse=True)[:max_rules]
        if not top:
            return ""
        lines = ["## Applicable Rules (from prior experience)\n"]
        for m in top:
            sr = self._success_rate(m.rule)
            lines.append(
                f"- **{m.rule['id']}** (confidence: {m.confidence}, "
                f"success rate: {sr:.0%})\n"
                f"  {m.rule['action']}"
            )
        return "\n".join(lines)

    def _success_rate(self, rule: dict) -> float:
        s = rule["stats"]
        if s["fired"] == 0:
            return 0.5  # neutral prior for untested rules
        return s["succeeded"] / s["fired"]

    def rank_matches(self, matches: list[RuleMatch]) -> list[RuleMatch]:
        """Sort matches by combined score (match confidence × success rate)."""
        return sorted(matches, key=lambda m: m.score, reverse=True)

    # ------------------------------------------------------------------
    # Parse LLM rule-matching response
    # ------------------------------------------------------------------

    def parse_match_response(self, llm_text: str) -> list[RuleMatch]:
        """
        Parse the LLM's rule-matching response.

        Expected format in a JSON code block:
        ```json
        {
          "matches": [
            {"rule_id": "r_001", "confidence": "high"},
            {"rule_id": "r_003", "confidence": "medium"}
          ]
        }
        ```
        """
        block_re = re.compile(r"```(?:json)?\s*(.*?)\s*```", re.DOTALL | re.IGNORECASE)
        for raw in block_re.findall(llm_text):
            try:
                obj = json.loads(raw)
                if isinstance(obj, dict) and "matches" in obj:
                    results = []
                    for m in obj["matches"]:
                        rid = m.get("rule_id", "")
                        conf = m.get("confidence", "medium")
                        rule = self.get(rid)
                        if rule:
                            conf_score = {"high": 0.9, "medium": 0.6, "low": 0.3}.get(conf, 0.5)
                            sr = self._success_rate(rule)
                            results.append(RuleMatch(
                                rule_id=rid,
                                confidence=conf,
                                score=conf_score * sr,
                                rule=rule,
                            ))
                    return self.rank_matches(results)
            except (json.JSONDecodeError, Exception):
                continue
        return []

    # ------------------------------------------------------------------
    # Parse MEDIATOR rule-creation/evolution response
    # ------------------------------------------------------------------

    def parse_mediator_rule_updates(self, mediator_text: str,
                                     task_id: str) -> list[dict]:
        """
        Parse MEDIATOR output for rule creation/evolution instructions.

        Expected JSON block:
        ```json
        {
          "rule_updates": [
            {
              "action": "new",
              "condition": "...",
              "rule_action": "...",
              "tags": ["gravity", "spatial"]
            },
            {
              "action": "generalize",
              "parent_id": "r_001",
              "condition": "...",
              "rule_action": "...",
              "reason": "original was too specific to downward gravity"
            },
            {
              "action": "specialize",
              "parent_id": "r_002",
              "condition": "...",
              "rule_action": "...",
              "reason": "fails on grids with border cells"
            }
          ]
        }
        ```

        Returns list of created/modified rule dicts.
        """
        block_re = re.compile(r"```(?:json)?\s*(.*?)\s*```", re.DOTALL | re.IGNORECASE)
        created: list[dict] = []
        for raw in block_re.findall(mediator_text):
            try:
                obj = json.loads(raw)
                if not isinstance(obj, dict) or "rule_updates" not in obj:
                    continue
                for upd in obj["rule_updates"]:
                    act = upd.get("action", "new")
                    cond = upd.get("condition", "")
                    ract = upd.get("rule_action", "")
                    tags = upd.get("tags", [])
                    reason = upd.get("reason", "")
                    parent = upd.get("parent_id", "")

                    if not cond or not ract:
                        continue

                    rule_type = upd.get("rule_type", "task")

                    if act == "generalize" and parent:
                        r = self.generalize_rule(parent, cond, ract, reason,
                                                  source_task=task_id, tags=tags)
                    elif act == "specialize" and parent:
                        r = self.specialize_rule(parent, cond, ract, reason,
                                                  source_task=task_id, tags=tags)
                    elif act == "merge":
                        pids = upd.get("parent_ids", [parent] if parent else [])
                        r = self.merge_rules(pids, cond, ract, reason,
                                              source_task=task_id, tags=tags)
                    else:
                        r = self.add_rule(cond, ract, source="mediator",
                                           source_task=task_id, tags=tags,
                                           rule_type=rule_type)
                    created.append(r)
            except (json.JSONDecodeError, Exception):
                continue
        return created

    # ------------------------------------------------------------------
    # Prompt builders
    # ------------------------------------------------------------------

    def build_match_prompt(self, task_text: str) -> str:
        """
        Build the user message for the rule-matching LLM call.
        """
        rules_listing = self.format_rules_for_matching()
        return (
            "You are a rule matcher. Given the ARC-AGI puzzle below and a list of "
            "rules, determine which rules' conditions match this puzzle.\n\n"
            "For each matching rule, rate confidence as high/medium/low.\n"
            "Only include rules whose conditions genuinely apply — do not force matches.\n\n"
            f"## Available Rules\n\n{rules_listing}\n\n"
            f"{task_text}\n\n"
            "Respond with a JSON block:\n"
            "```json\n"
            '{"matches": [{"rule_id": "r_001", "confidence": "high"}, ...]}\n'
            "```\n"
            "If no rules match, return an empty matches array."
        )

    def build_mediator_rule_section(self, fired: list[RuleMatch],
                                     success: bool) -> str:
        """
        Build a prompt section instructing MEDIATOR to update rules.
        Shows all existing rules so MEDIATOR can merge/generalize instead of duplicating.
        """
        parts = ["\n## Rule System\n"]

        # Show ALL active rules so MEDIATOR can detect duplicates before creating new ones
        all_active = self.active_rules()
        if all_active:
            parts.append("### Existing rules (check before creating new ones)\n")
            for r in all_active:
                sr = self._success_rate(r)
                rtype = r.get("rule_type", "task")
                parts.append(
                    f"- [{r['id']}] type={rtype} tags={r.get('tags',[])} success={sr:.0%} fired={r['stats']['fired']}x\n"
                    f"  CONDITION: {r['condition']}\n"
                    f"  ACTION: {r['action'][:120]}"
                )

        if fired:
            parts.append("\n### Rules matched for this task\n")
            for m in fired:
                parts.append(f"- {m.rule_id}: {m.rule['condition'][:80]}")
            outcome = "SUCCEEDED" if success else "FAILED"
            parts.append(f"\nThe ensemble {outcome} on this task.")

        if not success:
            parts.append(
                "\nSince the task failed, consider:\n"
                "- Were fired rules too broad? → **specialize** them\n"
                "- Were fired rules misleading? → create a **new** rule with better guidance\n"
                "- Was a correct rule missing? → create a **new** rule for this puzzle type"
            )
        else:
            parts.append(
                "\nSince the task succeeded, consider:\n"
                "- Can the successful approach be captured as a rule?\n"
                "- Can any existing rule be **generalized** to cover this puzzle type too?"
            )

        parts.append(
            "\n### Rule writing guidelines\n"
            "**DEDUPLICATION**: Before writing `action: new`, scan the existing rules above. "
            "If an existing rule covers the same transformation category, prefer `generalize` or `merge` over `new`. "
            "Do NOT create a new rule if one already exists with a very similar condition.\n\n"
            "**CONDITION FORMAT**: Start every condition with a category tag in brackets, e.g.:\n"
            "  `[gravity] Grid contains objects that need to be sorted by type...`\n"
            "  `[path-drawing] Grid has exactly 3 colored points on a black background...`\n"
            "  `[proximity] Grid has two boundary lines and scattered trigger cells...`\n"
            "Categories: gravity, path-drawing, proximity, flood-fill, object-manipulation, "
            "sorting, completion, extraction, scaling, rule-induction\n\n"
            "**GENERALITY**: Conditions should describe a *category* of puzzles, not a specific puzzle. "
            "Avoid encoding specific colors, specific grid sizes, or specific coordinates.\n\n"
            "To update rules, include a JSON block:\n"
            "```json\n"
            '{"rule_updates": [\n'
            '  {"action": "new", "condition": "[category] ...", "rule_action": "...", "tags": [...]},\n'
            '  {"action": "generalize", "parent_id": "r_001", "condition": "[category] ...", "rule_action": "...", "reason": "..."},\n'
            '  {"action": "merge", "parent_ids": ["r_003", "r_005"], "condition": "[category] ...", "rule_action": "...", "reason": "..."}\n'
            "]}\n"
            "```\n"
            "Omit the rule_updates block if no changes are needed."
        )
        return "\n".join(parts)
