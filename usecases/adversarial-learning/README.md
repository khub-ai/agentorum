# Adversarial Learning

> **Status: Planned** — concept validated; requires [Knowledge Fabric](https://github.com/khub-ai/khub-knowledge-fabric) integration for persistable learning. Not yet implemented.

> **Can an adversarial multi-agent arrangement accelerate inductive learning on a target domain, producing persistent knowledge that demonstrably improves agent performance in subsequent sessions?**

---

## The idea

Generative Adversarial Networks (GANs) demonstrated that two neural networks arranged in opposition — a Generator and a Discriminator — evolve faster than either would alone. The adversarial pressure creates a training signal: the Generator improves because the Discriminator punishes weak outputs, and the Discriminator improves because the Generator forces it to distinguish increasingly sophisticated fakes from real data.

This use case applies the same structural insight to LLM agent ensembles — but with a fundamentally different learning mechanism.

In GANs, learning happens through backpropagation: gradients flow, weights update, behaviour changes. LLM agents do not update their weights during inference. A naive adversarial arrangement between LLM agents produces better outputs within a single session (adversarial refinement), but neither agent retains anything afterward. The session ends, the context is discarded, and neither agent is any better at the task than when it started.

**Knowledge Fabric changes this.** The [Persistable Interactive Learning](https://github.com/khub-ai/khub-knowledge-fabric) framework provides agent-side induction: agents observe patterns in their interactions, derive general rules from those patterns, and persist those rules as explicit knowledge artifacts. In subsequent sessions, agents read their accumulated knowledge before engaging — and their behaviour is measurably different because of it.

With Knowledge Fabric providing the learning substrate and Agentorum providing the adversarial orchestration, the complete loop becomes:

**Adversarial pressure → inductive reasoning → persisted knowledge → improved behaviour → harder adversarial pressure → deeper induction → …**

This is structurally equivalent to the GAN training loop, with symbolic induction replacing gradient descent.

---

## Why this is stronger than the GAN analogy suggests

The GAN parallel is useful as motivation, but the Knowledge Fabric mechanism has three structural advantages over subsymbolic (weight-based) learning:

### 1. Interpretability

In a GAN, what the Generator "learned" is encoded in millions of opaque weight values. You can observe that it produces better outputs, but you cannot inspect the learned knowledge directly.

In Knowledge Fabric, what the agent learned is an explicit artifact — a rule, a pattern, a corrected misconception. You can read it, audit it, and understand why the agent's behaviour changed. When an adversarial session produces a rule like "When estimating structural load, account for wind shear in buildings above 12 storeys — my initial calculation omitted this and ATTACKER demonstrated the failure case," that is an interpretable, auditable learning outcome.

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
| **INDUCTOR** | Knowledge extraction | After each round, reviews the exchange and extracts generalisable rules. Writes them to the LEARNER's persistent knowledge store via Knowledge Fabric. |
| **HUMAN** | Session designer and reviewer | Selects problems, sets the domain, reviews induced knowledge, and steers the adversarial process. |

### Why the JUDGE is essential

LLMs have a well-documented sycophancy problem that runs in both directions:

- In cooperative mode, agents agree too readily with each other's claims
- In adversarial mode, agents concede too readily to each other's attacks

Without a JUDGE, ATTACKER can challenge a correct answer and LEARNER may capitulate — inducing a wrong rule that degrades future performance. The JUDGE breaks this failure mode by independently evaluating whether each challenge is substantive. Only JUDGE-validated challenges feed into the induction process.

### Why the INDUCTOR is separate from the LEARNER

Induction — the extraction of general rules from specific cases — is a distinct cognitive task from problem-solving. Combining them in a single agent risks conflation: the LEARNER might induce rules that are too specific to the current problem, or too eager to generalise from a single failure. The INDUCTOR sees the full exchange at arm's length and produces cleaner, more generalisable rules.

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
5. **INDUCTOR** reviews all learning events from this round and extracts generalisable rules. These are persisted to Knowledge Fabric.

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

The closest analogue in traditional ML is **case-based reasoning** augmented with **rule induction** — but operating entirely through natural language rather than formal logic.

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
| **Rule quality** | What fraction of induced rules are correct, generalisable, and applied in subsequent sessions? |
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
| **Adversarial Learning** | Competitive | Robustness through attack/defence + persistent knowledge | **Yes** (cross-session via Knowledge Fabric) |

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

## Related

- [← All use cases](../README.md)
- [Agentorum home](../../README.md)
- [Agent Ensemble as Super Intelligence](../agent-ensemble-superintelligence/) — cooperative ensemble on GPQA Diamond benchmark
- [VLM Ensemble Image Analysis](../vlm-ensemble-image-analysis/) — vision model ensemble for image analysis
- [Knowledge Fabric](https://github.com/khub-ai/khub-knowledge-fabric) — persistable interactive learning framework
- [Full design specification](../../specs/design-spec.md)
