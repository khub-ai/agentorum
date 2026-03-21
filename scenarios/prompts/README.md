# System Prompt Library

Reusable base prompt templates for each agent role type in Agentorum. These templates are designed to be composed into scenarios — a scenario selects role types, fills in configurable parameters (domain, aggressiveness, criteria, etc.), and produces a complete system prompt for each participant.

## Role Types

### Core Roles (used in most scenarios)

| Role | File | Purpose |
|---|---|---|
| **SOLVER** | [solver.md](solver.md) | Independent analysis, commit to a clear answer, show full reasoning |
| **CRITIC** | [critic.md](critic.md) | Find flaws, challenge assumptions, demand evidence |
| **SYNTHESIZER** | [synthesizer.md](synthesizer.md) | Integrate all positions into a unified, honest conclusion |
| **MODERATOR** | [moderator.md](moderator.md) | Process control — track coverage, manage turns, escalate, redirect |

### Specialized Roles

| Role | File | Purpose |
|---|---|---|
| **DOMAIN-EXPERT** | [domain-expert.md](domain-expert.md) | Deep knowledge in a specific field; defers outside their area |
| **RED-TEAM** | [red-team.md](red-team.md) | Simulate attacks, find vulnerabilities, stress-test systems |
| **FACT-CHECKER** | [fact-checker.md](fact-checker.md) | Verify factual claims; classify as verified/incorrect/misleading |
| **DEVIL'S-ADVOCATE** | [devils-advocate.md](devils-advocate.md) | Argue the opposite of consensus to prevent groupthink |
| **JUDGE** | [judge.md](judge.md) | Score arguments on defined criteria, declare winners, remain neutral |

### Adversarial Learning Roles (require Knowledge Fabric)

| Role | File | Purpose |
|---|---|---|
| **INDUCTOR** | [inductor.md](inductor.md) | Observe exchanges, extract general rules, persist learnings |
| **LEARNER** | [learner.md](learner.md) | Start with minimal knowledge, improve through adversarial feedback |
| **ATTACKER** | [attacker.md](attacker.md) | Generate targeted counterexamples to expose and close knowledge gaps |

## Template Syntax

Templates use Handlebars-style placeholders:

- `{{DISPLAY_NAME}}` — the participant's display name from the scenario config
- `{{DOMAIN}}` — domain specialization (e.g., "cybersecurity", "financial analysis")
- `{{#if FIELD}}...{{/if}}` — conditional sections included only when the parameter is set
- `{{#each LIST}}...{{/each}}` — repeated sections for arrays (e.g., respond-when criteria)
- `{{AGGRESSIVENESS}}` — numeric 1-5 scale for CRITIC intensity
- `{{CREDENTIALS}}` — background/credentials description for DOMAIN-EXPERT
- `{{KNOWLEDGE_FILE}}` — path to persisted knowledge for LEARNER

## Composability

Roles are designed to be mixed. Common combinations:

- **CRITIC + JUDGE** — evaluates reasoning quality and scores arguments
- **DOMAIN-EXPERT + SOLVER** — deep domain analysis with clear position-taking
- **RED-TEAM + ATTACKER** — security-focused adversarial pressure with pedagogical structure
- **MODERATOR + SYNTHESIZER** — process control with periodic consolidation (use sparingly — these roles have different timing needs)

## Design Principles

1. **Every prompt includes anti-patterns.** Telling an agent what NOT to do is as important as telling it what to do. LLMs have strong default behaviors (sycophancy, hedging, verbosity) that must be explicitly suppressed.

2. **Self-selection criteria are built in.** Every role includes respond-when and stay-silent-when lists so agents can self-select in large ensembles without requiring a central router for every entry.

3. **Response formats are structured.** Each role defines a specific output format so entries are scannable and the information architecture is consistent across a session.

4. **Roles are honest about their limits.** DOMAIN-EXPERTs defer outside their domain. JUDGEs flag when they lack expertise to evaluate a claim. FACTs say "Unverified" rather than guessing. This calibration is essential for ensemble reliability.
