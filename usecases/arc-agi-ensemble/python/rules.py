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
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.path, "w", encoding="utf-8") as f:
            json.dump(self._data, f, indent=2)

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
        """Return rules that are not deprecated."""
        return [r for r in self.rules if r.get("status", "active") == "active"]

    def stats_summary(self) -> dict[str, Any]:
        active = self.active_rules()
        total = len(self.rules)
        deprecated = total - len(active)
        fired = sum(r["stats"]["fired"] for r in active)
        succeeded = sum(r["stats"]["succeeded"] for r in active)
        return {
            "total": total,
            "active": len(active),
            "deprecated": deprecated,
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

        Returns:
            The newly created rule dict.
        """
        rule = {
            "id": self._next_id(),
            "condition": condition,
            "action": action,
            "stats": {"fired": 0, "succeeded": 0, "failed": 0},
            "source": source,
            "source_task": source_task,
            "tags": tags or [],
            "lineage": lineage or {"type": "new", "parent_ids": [], "reason": ""},
            "status": "active",
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
        """Create a more general rule derived from an existing one."""
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
        Build a prompt fragment listing all active rules for the LLM to evaluate.
        Returns a numbered list the LLM can reference by ID.
        """
        active = self.active_rules()
        if not active:
            return "(no rules in the rule base)"
        lines = []
        for r in active:
            sr = self._success_rate(r)
            lines.append(
                f"- [{r['id']}] (success {sr:.0%}, fired {r['stats']['fired']}x)\n"
                f"  CONDITION: {r['condition']}\n"
                f"  ACTION: {r['action']}"
            )
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
                                           source_task=task_id, tags=tags)
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
        """
        parts = ["\n## Rule System\n"]

        if fired:
            parts.append("The following rules were fired for this task:")
            for m in fired:
                parts.append(f"- {m.rule_id}: {m.rule['condition'][:80]}")
            outcome = "SUCCEEDED" if success else "FAILED"
            parts.append(f"\nThe ensemble {outcome} on this task.")

        if not success:
            parts.append(
                "\nSince the task failed, consider:\n"
                "- Were the fired rules' conditions too broad? → **specialize** them\n"
                "- Were the fired rules' actions misleading? → create a **new** rule with better guidance\n"
                "- Was a correct rule missing? → create a **new** rule for this puzzle type\n"
                "- Could a fired rule be **generalized** to cover more cases while still being correct?"
            )
        else:
            parts.append(
                "\nSince the task succeeded, consider:\n"
                "- Can the successful approach be captured as a **new** rule?\n"
                "- Can any fired rule be **generalized** to cover similar puzzles?"
            )

        parts.append(
            "\nTo update rules, include a JSON block:\n"
            "```json\n"
            '{"rule_updates": [\n'
            '  {"action": "new", "condition": "...", "rule_action": "...", "tags": [...]},\n'
            '  {"action": "generalize", "parent_id": "r_001", "condition": "...", "rule_action": "...", "reason": "..."},\n'
            '  {"action": "specialize", "parent_id": "r_002", "condition": "...", "rule_action": "...", "reason": "..."}\n'
            "]}\n"
            "```\n"
            "Omit the rule_updates block if no changes are needed."
        )
        return "\n".join(parts)
