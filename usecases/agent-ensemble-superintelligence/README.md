# Agent Ensemble as Super Intelligence

> **Can a group of agents, working together, outperform any individual agent on a hard benchmark?**
> This use case sets out to prove it — and to show exactly how the ensemble does it.

---

## The question this answers

State-of-the-art AI models are tested in isolation. A benchmark score tells you how well one model performs on one run. But the ceiling for a single model is fixed by its training, its architecture, and its context window.

What if the test subject is not one model, but an ensemble — a structured group of agents with different strengths, deliberating together toward a shared answer?

This use case is a live experiment. We run a recognised, difficult benchmark through an Agentorum ensemble and compare the result against published single-model scores on the same benchmark. The hypothesis: **structured multi-agent deliberation produces answers that are more accurate, more robust, and better calibrated than any individual participant could produce alone.**

---

## Why this matters

Most discussions of AI "superintelligence" imagine a single, vastly more capable model. This use case explores an alternative path: **collective intelligence through structure**. A group of specialised agents — each strong in different areas, each able to challenge the others — coordinating toward a shared answer.

This is not a new idea. It is how expert panels, scientific peer review, and legal adversarial proceedings work. What is new is the ability to operationalise it at speed, with any combination of models, with a full audit trail of how the answer was reached.

If the ensemble consistently outperforms its strongest individual member, that has direct implications for:

- How AI systems should be deployed on high-stakes decisions
- Whether multi-agent deliberation can substitute for model scale on tasks where scale alone has hit a ceiling
- What "alignment" looks like when the check on any one agent is the other agents in the group

---

## The setup (planned)

The ensemble will consist of agents with deliberately differentiated roles — not all doing the same thing, but each contributing a distinct epistemic function:

| Agent | Role |
|---|---|
| **SOLVER-A** | Attempts the benchmark question independently — first-pass answer |
| **SOLVER-B** | Independent second attempt — different model, no access to SOLVER-A's reasoning |
| **CRITIC** | Identifies flaws, edge cases, or hidden assumptions in both solutions |
| **VERIFIER** | Checks proposed answers against known constraints, ground truth heuristics, or worked examples |
| **SYNTH** | Weighs the evidence from all agents and proposes the ensemble's final answer |
| **HUMAN** | Observes, steers, and approves the final answer |

The benchmark, participant model assignments, and full session transcripts will be published here once the experiment is complete.

---

## What will be measured

- **Accuracy** — ensemble answer vs. single-model answer vs. published benchmark scores
- **Calibration** — does the ensemble correctly identify when it is uncertain?
- **Failure modes** — where does the ensemble underperform a single model, and why?
- **Process efficiency** — how many deliberation turns are needed before convergence?
- **Auditability** — can a human follow the reasoning that produced the final answer?

Results will be published as a full session export alongside the analysis.

---

## Status

**In development.** Benchmark selection and agent configuration are underway. The bundle file and full results will be added here when the first run is complete.

If you want to follow progress or contribute benchmark suggestions, watch this repository or open an issue.

---

## Related

- [← All use cases](../README.md)
- [Agentorum home](../../README.md)
- [Software Development Review](../software-dev-review/) — two coding agents independently reviewing the same code
- [Full design specification](../../specs/design-spec.md)
