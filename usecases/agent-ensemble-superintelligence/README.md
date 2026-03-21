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

## The benchmark: GPQA Diamond

After evaluating several candidates — including AIME, BIG-Bench Hard, MATH Level 5, and ARC-Challenge — we selected **GPQA Diamond** as the benchmark for this experiment.

**What it is:** 198 multiple-choice questions (4 options each) written by PhD-level domain experts in biology, physics, and chemistry. The questions are deliberately constructed so that non-experts with full internet access score only ~34% — you cannot pass them by retrieval or pattern-matching alone. Answering correctly requires genuine multi-step domain reasoning.

**Why it fits:**

| Criterion | GPQA Diamond |
|---|---|
| Genuinely hard for second-tier models | ✅ Individual scores: 41–50% |
| Clear room for ensemble improvement | ✅ PhD expert ceiling: ~70% |
| Unambiguous scoring (no human judgment) | ✅ Multiple choice A/B/C/D |
| Affordable to run | ✅ Full 4-agent run: ~$2–5 |
| Credible, widely cited | ✅ Used in major frontier model evaluations |

**Why not the alternatives:**

- *AIME (30 questions)* — too few questions; a one-question difference is a 3.3% swing, making it statistically fragile for ensemble comparisons.
- *BIG-Bench Hard* — mixed answer formats; some tasks require human judgment to score, complicating clean evaluation.
- *MATH Level 5* — too expensive for a first run (~$15–40 for the full level-5 set); exact LaTeX answer matching also adds evaluation complexity.
- *ARC-Challenge* — second-tier models now score 75–85%, leaving little room to demonstrate improvement.

---

## The ensemble

Four agents, each contributing a distinct epistemic function. Deliberately using second and third-tier models — not frontier — to make the point that the improvement comes from structure, not from model power.

| Agent | Model | Baseline GPQA score | Role |
|---|---|---|---|
| **SOLVER-A** | Claude Haiku 3.5 | 41.6% | First independent pass — full reasoning, commits to an answer |
| **SOLVER-B** | Gemini 1.5 Flash | ~41–43% | Second independent pass — different model family, different blind spots |
| **CRITIC** | GPT-4o-mini | 50.3% | Reads both solutions; identifies where reasoning diverges and challenges any shaky step |
| **SYNTH** | Claude Haiku 3.5 | — | Weighs the evidence from all three; posts the ensemble's final answer with justification |

**Why these models:** All three model families (Anthropic, Google, OpenAI) are represented. Each has distinct training data, architecture, and reasoning patterns — so their errors are not perfectly correlated. Where SOLVER-A and SOLVER-B independently reach the same answer, that is a strong signal. Where they diverge, CRITIC's job is to find out why — and SYNTH's job is to resolve it.

**Why not frontier models:** Using GPT-4, Claude Opus, or Gemini Ultra would conflate model capability with ensemble structure. The goal is to show that modest models, coordinating well, can reach scores that exceed what any one of them achieves alone. That is the interesting result.

---

## How each question is deliberated

For every GPQA Diamond question, the ensemble runs this sequence:

1. **SOLVER-A** reads the question in isolation and posts a full answer with step-by-step reasoning. It commits to a choice (A, B, C, or D).
2. **SOLVER-B** does the same — independently, without seeing SOLVER-A's response. It commits to its own choice.
3. **CRITIC** reads both responses. It identifies where the reasoning steps differ, challenges any inference that looks weak, and flags which answer has stronger justification — or whether both could be wrong.
4. **SYNTH** reads all three entries and posts the ensemble's final answer: the chosen option, a one-paragraph justification, and a confidence level (high / medium / low).

Scoring: the ensemble's final answer is compared against the GPQA answer key. This is run across all 198 questions and compared against each individual model's standalone accuracy on the same set.

---

## What will be measured

- **Accuracy** — ensemble vs. each individual model vs. published single-model benchmarks
- **Agreement rate** — how often SOLVER-A and SOLVER-B independently agree; whether agreement predicts correctness
- **CRITIC impact** — how often CRITIC's intervention changes the final answer, and whether those changes improve accuracy
- **Calibration** — does SYNTH's confidence level correlate with actual correctness?
- **Failure modes** — where does the ensemble underperform, and why? (Both solvers wrong? CRITIC overrides a correct answer?)
- **Cost efficiency** — accuracy per dollar compared to running a single stronger model

Full session transcripts and scored results will be published here when the experiment is complete.

---

## Status

**Benchmark selected. In development.**

Next steps: agent system prompts, evaluation harness, baseline run (each model solo), ensemble run, results analysis.

If you want to follow progress or contribute, watch this repository or open an issue.

---

## Related

- [← All use cases](../README.md)
- [Agentorum home](../../README.md)
- [Software Development Review](../software-dev-review/) — two coding agents independently reviewing the same code
- [Full design specification](../../specs/design-spec.md)
