# Adversarial Learning

> **Status: Planned** — concept validated; requires [Knowledge Fabric](https://github.com/khub-ai/khub-knowledge-fabric) integration for persistable learning. Not yet implemented.

> **Can an adversarial multi-agent arrangement accelerate inductive learning on a target domain, producing persistent knowledge that demonstrably improves agent performance in subsequent sessions?**

---

## The idea

Generative Adversarial Networks (GANs) demonstrated that two neural networks arranged in opposition — a Generator and a Discriminator — evolve faster than either would alone. The adversarial pressure creates a training signal: the Generator improves because the Discriminator punishes weak outputs, and the Discriminator improves because the Generator forces it to distinguish increasingly sophisticated fakes from real data.

This use case applies the same structural insight to LLM agent ensembles — but with a fundamentally different learning mechanism.

In GANs, learning happens through backpropagation: gradients flow, weights update, behavior changes. LLM agents do not update their weights during inference. A naive adversarial arrangement between LLM agents produces better outputs within a single session (adversarial refinement), but neither agent retains anything afterward. The session ends, the context is discarded, and neither agent is any better at the task than when it started.

**Knowledge Fabric changes this.** The [Persistable Interactive Learning](https://github.com/khub-ai/khub-knowledge-fabric) framework provides agent-side induction: agents observe patterns in their interactions, derive general rules from those patterns, and persist those rules as explicit knowledge artifacts. In subsequent sessions, agents read their accumulated knowledge before engaging — and their behavior is measurably different because of it.

With Knowledge Fabric providing the learning substrate and Agentorum providing the adversarial orchestration, the complete loop becomes:

**Adversarial pressure → inductive reasoning → persisted knowledge → improved behavior → harder adversarial pressure → deeper induction → …**

This is structurally equivalent to the GAN training loop, with symbolic induction replacing gradient descent.

---

## Why this is stronger than the GAN analogy suggests

The GAN parallel is useful as motivation, but the Knowledge Fabric mechanism has three structural advantages over subsymbolic (weight-based) learning:

### 1. Interpretability

In a GAN, what the Generator "learned" is encoded in millions of opaque weight values. You can observe that it produces better outputs, but you cannot inspect the learned knowledge directly.

In Knowledge Fabric, what the agent learned is an explicit artifact — a rule, a pattern, a corrected misconception. You can read it, audit it, and understand why the agent's behavior changed. When an adversarial session produces a rule like "When estimating structural load, account for wind shear in buildings above 12 stories — my initial calculation omitted this and ATTACKER demonstrated the failure case," that is an interpretable, auditable learning outcome.

### 2. Transferability

A GAN's Generator cannot hand its learned distribution to a different network. The knowledge is locked in the weights of that specific architecture.

Knowledge induced through adversarial sessions in Knowledge Fabric is model-agnostic. An insight that Agent A learned from being challenged by Agent B can be shared with Agent C, applied in a different session, or composed with independently-learned knowledge from other domains. The knowledge travels as text, not as weights.

### 3. Composability

The adversarial learning in Agentorum stacks with cooperative ensembles. An agent that has been hardened through adversarial sessions can then participate in a cooperative Super Intelligence ensemble (see [Agent Ensemble as Super Intelligence](../agent-ensemble-superintelligence/)) — bringing its accumulated knowledge to the group. The adversarial phase builds individual depth; the cooperative phase leverages collective breadth. GANs do not compose this way.

---

## The ensemble structure

Five participants arranged in an adversarial loop with a learning layer.

| Agent | Role | Function |
|---|---|---|
| **LEARNER** | The agent under adversarial training | Attempts to solve problems in the target domain. Starts with baseline knowledge. Induces rules from its failures and from ATTACKER's challenges. |
| **ATTACKER** | The adversarial counterpart | Systematically probes LEARNER's solutions for flaws: logical gaps, missing edge cases, incorrect assumptions, unstated dependencies. Its job is to find weaknesses, not to be agreeable. |
| **JUDGE** | Adjudicator | Evaluates each LEARNER ↔ ATTACKER exchange. Determines whether ATTACKER's challenge is valid or spurious. Prevents sycophantic collapse (LEARNER conceding to incorrect attacks). |
| **INDUCTOR** | Knowledge extraction | After each round, reviews the exchange and extracts generalizable rules. Writes them to the LEARNER's persistent knowledge store via Knowledge Fabric. |
| **HUMAN** | Session designer and reviewer | Selects problems, sets the domain, reviews induced knowledge, and steers the adversarial process. |

### Why the JUDGE is essential

LLMs have a well-documented sycophancy problem that runs in both directions:

- In cooperative mode, agents agree too readily with each other's claims
- In adversarial mode, agents concede too readily to each other's attacks

Without a JUDGE, ATTACKER can challenge a correct answer and LEARNER may capitulate — inducing a wrong rule that degrades future performance. The JUDGE breaks this failure mode by independently evaluating whether each challenge is substantive. Only JUDGE-validated challenges feed into the induction process.

### Why the INDUCTOR is separate from the LEARNER

Induction — the extraction of general rules from specific cases — is a distinct cognitive task from problem-solving. Combining them in a single agent risks conflation: the LEARNER might induce rules that are too specific to the current problem, or too eager to generalize from a single failure. The INDUCTOR sees the full exchange at arm's length and produces cleaner, more generalizable rules.

---

## How a session works

### Phase 1: Baseline assessment

LEARNER solves N problems from the target domain without any prior knowledge. Its accuracy is recorded as the baseline.

### Phase 2: Adversarial rounds

For each problem:

1. **LEARNER** reads its accumulated knowledge (if any) and attempts a solution with full reasoning.
2. **ATTACKER** reads the solution and systematically challenges it — identifying logical gaps, unstated assumptions, missing edge cases, or outright errors.
3. **LEARNER** responds to each challenge: defending correct reasoning with stronger justification, or revising where the attack exposed a genuine flaw.
4. **JUDGE** evaluates the exchange. For each challenge:
   - If ATTACKER's challenge is valid and LEARNER's revision is correct → **learning event** (LEARNER improved)
   - If ATTACKER's challenge is valid but LEARNER incorrectly conceded a correct answer → **sycophancy event** (flagged; no induction)
   - If ATTACKER's challenge is spurious → **noise event** (dismissed)
5. **INDUCTOR** reviews all learning events from this round and extracts generalizable rules. These are persisted to Knowledge Fabric.

### Phase 3: Post-training assessment

LEARNER solves a held-out set of problems from the same domain — problems it has not seen during adversarial rounds — using its accumulated knowledge. Its accuracy on the held-out set is compared against:

- Its own baseline (Phase 1)
- A control agent that solved the same number of problems without adversarial pressure (just repeated practice)
- Published single-model benchmarks for the same task

The control comparison is critical: it distinguishes "learning through adversarial pressure" from "learning through exposure to more examples." If the adversarial agent outperforms the control agent despite seeing the same number of problems, the adversarial structure itself is the cause of the improvement.

---

## The learning mechanism in detail

Knowledge Fabric's agent-side induction works as follows:

1. **Observation** — the agent participates in a session and produces outputs (solutions, arguments, revisions)
2. **Challenge** — the adversary identifies specific failure points with concrete counterexamples
3. **Induction** — the INDUCTOR extracts a general rule from the specific failure: "When X, I should consider Y because Z"
4. **Persistence** — the induced rule is written to the agent's knowledge store as an explicit, retrievable artifact
5. **Application** — in subsequent sessions, the agent reads its knowledge store before engaging and applies accumulated rules to new problems

The adversarial arrangement is important at step 2. Without an adversary, the agent's failures are implicit — it simply gets the wrong answer and moves on. The adversary makes failures explicit, specific, and actionable: "Your answer fails because in the case where P, your assumption Q does not hold — here is why." This is a much richer signal for induction than a binary right/wrong label.

### What "learning" means here

To be precise about terminology:

- **Not weight updates** — no model parameters change during or after the session
- **Not fine-tuning** — no training runs are involved
- **Not RAG** — the knowledge store is not a vector database of retrieved documents; it is a structured collection of induced rules
- **It is symbolic induction** — the agent derives general rules from specific cases, persists them as explicit knowledge, and applies them in future sessions via in-context conditioning

The closest analog in traditional ML is **case-based reasoning** augmented with **rule induction** — but operating entirely through natural language rather than formal logic.

---

## Candidate domains

The adversarial learning pattern is domain-general, but some domains are better suited to early experiments:

### Code security (leading candidate)

- **Task:** LEARNER writes code to solve a specification; ATTACKER red-teams it for security vulnerabilities (injection, overflow, race conditions, auth bypass)
- **Why it fits:** failures are concrete and verifiable (you can demonstrate the exploit); induced rules are actionable ("always sanitise user input before SQL interpolation"); improvement is measurable (CVE count per round)
- **Measurability:** number of vulnerabilities found per round, time-to-find, severity distribution

### Mathematical reasoning

- **Task:** LEARNER solves multi-step math problems; ATTACKER checks each inference step and presents counterexamples where steps are invalid
- **Why it fits:** ground truth is unambiguous; each step can be independently verified; induced rules are precise ("when dividing by a variable, check for the zero case")
- **Measurability:** accuracy on held-out problem sets, error type distribution across rounds

### Legal argument construction

- **Task:** LEARNER constructs a legal argument for a position; ATTACKER plays opposing counsel and challenges evidentiary claims, logical structure, and precedent applicability
- **Why it fits:** adversarial argument is the native mode of legal reasoning; JUDGE naturally maps to a judicial role; induced rules map to legal principles and argumentation patterns
- **Measurability:** harder to quantify; would require expert evaluation of argument quality

### Factual claim verification

- **Task:** LEARNER makes factual claims about a topic; ATTACKER presents counterevidence or alternative interpretations
- **Why it fits:** directly tests whether adversarial pressure improves calibration and reduces hallucination
- **Measurability:** factual accuracy rate, calibration score, hallucination rate

---

## What will be measured

### Primary metrics

| Metric | What it shows |
|---|---|
| **Baseline → post-training accuracy** | Did the adversarial process improve LEARNER's performance? |
| **Adversarial vs. control** | Did adversarial pressure produce faster/deeper learning than the same amount of non-adversarial practice? |
| **Knowledge accumulation curve** | How many rules were induced per round? Does the rate plateau? |
| **Rule quality** | What fraction of induced rules are correct, generalizable, and applied in subsequent sessions? |
| **Sycophancy rate** | How often did LEARNER incorrectly concede to ATTACKER? Did the JUDGE successfully prevent these from becoming induced rules? |

### Secondary metrics

- **ATTACKER difficulty curve** — as LEARNER improves, does ATTACKER's job get harder? (Measured by: average number of challenges per round, severity of found issues)
- **Transfer learning** — does knowledge induced in domain X improve performance on related domain Y?
- **Forgetting** — over many rounds, do early-induced rules remain applicable or do they conflict with later rules?
- **Cost efficiency** — accuracy improvement per dollar spent on API calls

---

## Relationship to other use cases

This use case is conceptually distinct from the other ensemble use cases, and the three compose naturally:

| Use case | Agent relationship | What improves | Learning? |
|---|---|---|---|
| [Super Intelligence](../agent-ensemble-superintelligence/) | Cooperative | Accuracy through collective reasoning | No (single-session) |
| [VLM Image Analysis](../vlm-ensemble-image-analysis/) | Cooperative | Completeness through independent observation | No (single-session) |
| **Adversarial Learning** | Competitive | Robustness through attack/defense + persistent knowledge | **Yes** (cross-session via Knowledge Fabric) |

The natural progression:
1. **Super Intelligence** demonstrates that multi-agent structure improves output quality within a single session
2. **VLM Image Analysis** extends this to visual domains via direct API calls
3. **Adversarial Learning** adds persistence — the ensemble doesn't just produce better outputs, it produces better agents

An agent trained through adversarial sessions can then participate in a cooperative Super Intelligence ensemble, bringing its accumulated knowledge to the group. The adversarial phase builds individual depth; the cooperative phase leverages collective breadth.

---

## Dependencies

| Dependency | Status | Notes |
|---|---|---|
| Agentorum multi-agent orchestration | ✅ Available | Core debate engine handles the adversarial session structure |
| Direct API agent backend | Planned | Required for non-CLI agents; shared dependency with VLM use case |
| [Knowledge Fabric](https://github.com/khub-ai/khub-knowledge-fabric) | In development | Provides agent-side induction and persistent knowledge storage |
| JUDGE role in automation rules | Planned | Needs server-side logic to gate induction on JUDGE approval |
| Evaluation harness | Not started | Automated scoring of baseline vs. post-training accuracy |

---

## Open questions

1. **Induction granularity** — should the INDUCTOR extract one rule per adversarial round, or wait for patterns across multiple rounds before generalising? Too-early induction risks overfitting to specific problems; too-late induction risks missing ephemeral insights.

2. **Knowledge store structure** — flat list of rules? Hierarchical (domain → sub-domain → specific rule)? Graph (rules that depend on or conflict with each other)? The right structure affects retrieval quality when the LEARNER reads its knowledge before a new session.

3. **Adversarial escalation** — as LEARNER improves, should ATTACKER be given progressively harder prompts or more capable models to maintain adversarial pressure? Or is a fixed ATTACKER sufficient because the problems themselves get harder as LEARNER handles the easy ones?

4. **Multi-domain interference** — if LEARNER is trained adversarially on domain A and then domain B, do the domain-A rules interfere with domain-B performance? This is the catastrophic forgetting problem, but in symbolic form.

5. **ATTACKER learning** — should ATTACKER also accumulate knowledge about LEARNER's weak points? This would make the adversarial dynamic more GAN-like (both sides improve), but risks creating an ATTACKER that is unfairly calibrated to one specific LEARNER rather than testing general robustness.

---

## Prior art and related work

This framework is a novel synthesis of existing ideas, not a fundamentally new concept. The individual components are well-established; the contribution is the specific combination and the testable hypothesis that adversarial signals produce richer inductive learning than self-reflection alone.

### Foundational work

- **Generative Adversarial Networks (GANs)** — Goodfellow et al., 2014. The original adversarial learning framework: a Generator and Discriminator co-evolve through adversarial pressure, each driving the other to improve. GANs demonstrated that adversarial arrangements create training signals that neither party could generate alone. Our framework draws the same structural insight but replaces gradient-based weight updates with symbolic induction — the adversarial pressure drives rule extraction rather than parameter optimization.

- **Self-play in reinforcement learning** — AlphaGo (Silver et al., 2016) and AlphaZero (Silver et al., 2017) demonstrated that adversarial self-play produces superhuman performance. Both agents improve through weight updates from game outcomes. Our framework operates in the language domain rather than game-play, and uses explicit rule induction rather than implicit policy learning.

### Closest prior work

- **Reflexion** — Shinn et al., 2023. An LLM agent reflects on its own task failures, generates verbal "reflections," and conditions on them in subsequent attempts. This is the closest precedent: it is agent-side verbal learning from failure, persisted across attempts. The key difference is the source of the learning signal — Reflexion uses **self-reflection** ("what did I do wrong?"), while our framework uses **adversarial challenge** ("here is exactly where your reasoning fails, with a concrete counterexample"). Our hypothesis is that adversarial signals are richer and more targeted than self-generated reflections, leading to faster and deeper induction.

- **ExpeL (Experiential Learning)** — Zhao et al., 2023. An agent extracts transferable insights from accumulated task experience and applies them to new tasks. Like Reflexion, the learning is self-driven rather than adversarially driven. ExpeL's insight extraction is analogous to our INDUCTOR role, but without the adversarial pressure that generates the raw material for extraction.

### Related but distinct

- **AI Safety via Debate** — Irving et al., 2018. Two agents argue opposing positions before a human judge. The focus is on alignment (can debate help humans supervise superhuman AI?) rather than on learning. The debate is single-session with no persistence.

- **Multi-agent debate for reasoning** — Du et al., 2023. Multiple agents debate to improve single-session reasoning accuracy. Demonstrates that adversarial interaction improves output quality, but without persistent learning — the agents start fresh each time.

- **Voyager** — Wang et al., 2023. A Minecraft agent that builds a persistent skill library through autonomous exploration. Demonstrates persistable learning through code generation, but the learning is exploratory rather than adversarial.

- **Generative Agents** — Park et al., 2023. Simulated agents with persistent memory that periodically reflect and form higher-level abstractions. Demonstrates persistent memory and reflection, but without adversarial structure or inductive rule extraction.

### What this framework adds

The testable hypothesis: **adversarial pressure from a dedicated ATTACKER agent produces more targeted, concrete, and actionable learning signals than self-reflection, leading to faster inductive learning and more robust induced rules.** The JUDGE role (preventing sycophantic collapse from corrupting the knowledge store) and the INDUCTOR separation (dedicated rule extraction rather than combined problem-solving-and-learning) are practical design contributions that address real failure modes in adversarial LLM interaction.

If controlled experiments confirm that adversarial induction outperforms self-reflective induction (Reflexion-style) on the same tasks, the contribution is empirically validated. If not, the framework remains an interesting architecture that doesn't outperform simpler alternatives — and that outcome is itself informative.

---

## Initial test cases for exploration

The first experiments should be small, affordable, and produce unambiguous results. The goal is not to prove the framework at scale but to establish whether the adversarial → induction → persistence loop works at all and whether it outperforms a Reflexion-style self-reflective baseline.

### Recommended: Logical reasoning with common fallacies

**Why this is the best starting point:**

- LLMs make **systematic, well-documented errors** on logical reasoning — affirming the consequent, base rate neglect, scope ambiguity, negation errors. These errors are consistent enough that an ATTACKER can reliably find them, and general enough that induced rules ("when given P→Q and Q, do not conclude P") transfer to unseen problems.
- Ground truth is **unambiguous** — logical validity is binary.
- Problems are **short** — a single reasoning puzzle fits in a few hundred tokens, keeping API costs minimal.
- The **adversarial signal is concrete** — the ATTACKER can present a specific counterexample that disproves the LEARNER's conclusion, which is exactly the kind of targeted signal that should drive good induction.
- **Existing datasets**: FOLIO (first-order logic), LogiQA (logical comprehension), ReClor (logical reasoning from standardized tests). All freely available.

**Proposed protocol:**

1. Select 60 problems from FOLIO or LogiQA: 20 for baseline, 20 for adversarial training, 20 held-out for evaluation.
2. Baseline: LEARNER solves 20 problems solo. Record accuracy.
3. Adversarial training: LEARNER attempts 20 problems; ATTACKER challenges each; JUDGE validates; INDUCTOR extracts rules. ~5 rules expected.
4. Evaluation: LEARNER (with induced rules) solves 20 held-out problems. Compare accuracy against baseline.
5. Control: Reflexion-style agent (same 20 training problems, self-reflection instead of adversarial challenge) solves the same 20 held-out problems.

**Estimated cost:** ~$1–3 total using second-tier models (Haiku, Flash, GPT-4o-mini). Fast enough to iterate multiple times in a day.

### Secondary: Math word problems with trap patterns

- **Dataset:** GSM8K hard subset or MATH (selected problems with known common-error patterns)
- **Why:** LLMs make characteristic mistakes on specific problem types (e.g., forgetting to convert units, miscounting combinatorial cases, dividing instead of multiplying). ATTACKER can present the numerical counterexample. Induced rules are precise ("when the problem involves unit conversion, explicitly state units at every step").
- **Trade-off:** Slightly more expensive than logical reasoning (longer chains of thought), but more visually impressive in a demo because the ATTACKER can show the concrete wrong answer.

### Stretch goal: ARC-AGI-v2 abstract reasoning

- **Dataset:** [ARC-AGI-v2](https://arcprize.org/) — abstract visual pattern recognition puzzles where the solver must infer a transformation rule from input-output grid pairs and apply it to a new input. Text-form puzzles are available at [dev-khub-ai/arctest2025](https://github.com/dev-khub-ai/arctest2025/tree/main/data).
- **Why it's compelling:** LLMs perform far below human level on ARC, so there's massive headroom for improvement. Each puzzle inherently requires **induction** (figure out the rule from examples), which maps directly to Knowledge Fabric's learning mechanism. The adversarial signal is concrete — ATTACKER can point out exactly which grid cells are wrong and why the proposed rule doesn't explain the training examples. If adversarial induction meaningfully improves ARC scores, that would be a dramatically more impressive result than improving logical reasoning.
- **Why it's risky as a first test:** ARC failures may be **capability-limited rather than knowledge-limited**. LLMs are fundamentally weak at spatial/grid manipulation in text form; no amount of induced verbal rules may fix that. The puzzles are also intentionally diverse — each tests a different transformation — so rules induced from one puzzle may not transfer to the next. If the experiment shows no improvement, it's hard to distinguish "the framework failed" from "the task is beyond what verbal induction can address."
- **Recommendation:** Use as a second-phase experiment after logical reasoning validates the basic loop. High risk, high reward.

### Deferred: Code security red-teaming

- **Why deferred:** Requires the direct API agent backend to be built first (agents need to execute and test code). The adversarial dynamic is excellent (ATTACKER writes exploit inputs, LEARNER patches) but the infrastructure dependency makes it a second-phase experiment.
- **When ready:** Use CWE Top 25 vulnerability patterns as the training domain. LEARNER writes a function to spec; ATTACKER finds an injection, overflow, or race condition; LEARNER patches; INDUCTOR extracts the security rule.

### What "success" looks like in the initial experiment

| Outcome | What it means |
|---|---|
| Adversarial agent accuracy > baseline accuracy on held-out set | The learning loop works — induced rules transfer to unseen problems |
| Adversarial agent accuracy > Reflexion agent accuracy | Adversarial signals are richer than self-reflective signals (core hypothesis confirmed) |
| Adversarial ≈ Reflexion | The adversarial structure adds complexity without benefit — simpler self-reflection suffices |
| Adversarial < baseline | Induced rules are wrong or overfitted — the JUDGE/INDUCTOR pipeline needs debugging |
| Sycophancy rate > 20% | JUDGE is not effectively filtering bad concessions — needs stronger prompting or a different model |

All outcomes are informative. The experiment is designed to produce a clear signal regardless of direction.

---

## Related

- [← All use cases](../README.md)
- [Agentorum home](../../README.md)
- [Agent Ensemble as Super Intelligence](../agent-ensemble-superintelligence/) — cooperative ensemble on GPQA Diamond benchmark
- [VLM Ensemble Image Analysis](../vlm-ensemble-image-analysis/) — vision model ensemble for image analysis
- [Knowledge Fabric](https://github.com/khub-ai/khub-knowledge-fabric) — persistable interactive learning framework
- [Full design specification](../../specs/design-spec.md)
