# VLM Ensemble Image Analysis

> **Status: Planned** — architecture and domain analysis documented; implementation not yet started.

---

## The idea

Vision-Language Models (VLMs) do not analyse an image the way a human does — scanning methodically, adjusting focus, re-examining. They process the entire image in a single forward pass through a visual encoder, and their attention is not uniformly distributed. Some regions of the image receive strong attention; others are underweighted. When a critical detail falls into a low-attention region, the model's reasoning is built on an incomplete foundation — and it typically has no awareness that it missed anything.

The fix is structural: **run multiple VLMs on the same image independently, then deliberate over their combined observations.** Different models have different visual encoders, trained on different data with different architectures. Their attention distributions are not correlated. A region that VLM-A underweights is not necessarily underweighted by VLM-B. When their descriptions diverge, that divergence is itself a signal — something in the image was ambiguous enough that two independently-trained models interpreted it differently, and that is exactly where a human reviewer's attention should go.

This is the VLM equivalent of the two-coding-agent review: independent parallel analysis, structured cross-critique, and a synthesis that is more complete than any individual pass could be.

---

## Why this works

Published research on VLM ensembles and self-consistency methods shows 5–15% accuracy gains on visual question-answering benchmarks. The gains are largest precisely in the failure modes that make VLMs unreliable in practice:

| VLM failure mode | Why an ensemble helps |
|---|---|
| **Object counting in dense scenes** | Different models make different counting errors; majority or deliberation converges more accurately |
| **Fine or degraded text** | Small, rotated, low-contrast, or partially occluded text; one model reads it wrong while another reads it right |
| **Spatial relationships** | "Is A above or behind B?" requires careful attention to depth and occlusion cues; models disagree and the CRITIC can identify which reasoning is sounder |
| **Subtle anomalies** | A hairline crack, an early-stage lesion, a misaligned component — requires focused attention on a small region that one model may not weight heavily |
| **Camouflage and occlusion** | Objects partially hidden or blending into background; models literally attend to different parts |
| **Unfamiliar perspectives** | Top-down (satellite), extreme close-up (macro), or non-standard orientations where training data is sparse |

In each case the ensemble's value is not just "more votes" — it is structured disagreement. When two models independently describe the same region differently, the ensemble's CRITIC can reason about which description is more internally consistent, and flag the discrepancy for synthesis or human review.

---

## The ensemble structure

Six participants, using direct VLM API calls — not CLI tools.

| Agent | Model (indicative) | Role |
|---|---|---|
| **ANALYST-A** | GPT-4o (vision) | First independent image analysis — full description, observations, and any anomalies noted |
| **ANALYST-B** | Gemini 1.5 Pro (vision) | Second independent analysis — different model family, separate visual encoder, no access to ANALYST-A's output |
| **ANALYST-C** | Claude 3.5 Sonnet (vision) | Third independent analysis — rounds out the model family coverage |
| **CRITIC** | Any capable model | Reads all three analyses; identifies where descriptions agree, where they diverge, and what the divergences imply |
| **SYNTH** | Any capable model | Produces the ensemble's consolidated finding: a structured description, flagged discrepancies, and confidence level per observation |
| **HUMAN** | — | Submits the image, steers the analysis, reviews the synthesis |

Model assignments will be finalised when the domain and specific task are chosen. The indicative models above represent the intended tier — capable vision models, but not necessarily the most expensive frontier option for every role.

---

## Technical approach: direct API calls (Path B)

All prior Agentorum use cases run agents via CLI tools (Claude Code, Codex CLI). This use case requires a different agent backend: **direct API calls with image payloads**.

When the human attaches an image in the session compose bar and posts it, the server:

1. Stores the image in the session's `media/` directory (already implemented)
2. Triggers each ANALYST agent by calling its vision API directly, passing the image URL or base64 payload alongside the system prompt and prior chatlog context
3. Posts the response as a new chatlog entry attributed to that agent
4. Proceeds through the deliberation sequence (CRITIC, SYNTH) the same way

This requires a new agent mode — `"agent": "api-vision"` — in the server's agent orchestration layer. The agent configuration would specify the API provider, model, and authentication. This is a planned infrastructure addition; this use case is its primary motivation.

Note: this same `api-vision` agent type will be useful beyond image analysis — it unlocks any use case where agents need to be driven by direct API calls rather than running as local CLI processes. Most future use cases will benefit from it.

---

## Domain candidates

The right domain has three properties: (1) the stakes are high enough that a missed detail matters, (2) the correct answer is verifiable, and (3) suitable images are freely available. Several strong candidates have been identified; the final choice will be made when implementation begins.

**Satellite / aerial imagery** *(leading candidate)*
- Use cases: disaster damage assessment, infrastructure monitoring, environmental change detection, construction activity detection
- Why VLM attention matters: top-down perspective is underrepresented in training data; scale cues are absent; subtle changes between images require fine attention
- Image sources: Copernicus Open Access Hub (ESA), NASA Earthdata, OpenAerialMap — all free and publicly licensed
- Ensemble story: ANALYST-A describes "residential structures"; ANALYST-B identifies one as a potential storage or industrial facility; CRITIC notes the discrepancy and reasons from roof shape and shadow angle; SYNTH flags it for human review

**Industrial defect detection**
- Use cases: manufacturing QC — surface cracks, solder bridges, misaligned components, foreign objects in production line images
- Why VLM attention matters: defects are often small relative to the image; they occur in arbitrary locations; the background is visually complex
- Image sources: MVTec Anomaly Detection Dataset (public), NEU Surface Defect Database (free for research)
- Ensemble story: two analysts call the surface clear; one flags a region as "possible surface irregularity"; CRITIC zooms in on that region's description and decides the evidence is strong enough to flag

**Historical documents and maps**
- Use cases: archival transcription, place-name identification, date reading, handwriting analysis
- Why VLM attention matters: degraded ink, archaic letterforms, faded regions — a character misread early propagates through the whole transcription
- Image sources: Library of Congress (public domain), British Library digitised collections, David Rumsey Map Collection
- Ensemble story: clean, uncontroversial domain; good for demonstrating text-in-image accuracy gains without domain sensitivity

**Medical imaging** *(deferred — see note)*
- Use cases: chest X-ray finding detection, pathology slide analysis, radiology second opinion
- Why VLM attention matters: subtle findings (early nodule, hairline fracture) are exactly the high-stakes missed-detail scenario
- Image sources: NIH ChestX-ray14 (112K public domain), RSNA datasets (Kaggle), CheXpert (Stanford)
- Note: VLMs are trained to refuse or heavily hedge on medical questions. This domain has the most compelling stakes but the most implementation friction. Deferred until VLM refusal behaviour is better understood in the context of this use case.

---

## What will be measured

Once a domain is selected and implementation is complete:

- **Completeness** — does the ensemble's synthesis capture more correct observations than any single analyst?
- **Discrepancy detection rate** — how often does the ensemble flag a genuine disagreement, and how often is the disagreement meaningful vs. noise?
- **False positive / false negative rate** — compared against ground truth annotations (where available)
- **CRITIC value** — how often does CRITIC's intervention change the synthesis, and in which direction?
- **Cost vs. accuracy trade-off** — ensemble cost (3× API calls per image) vs. accuracy gain over single-model baseline

---

## Related

- [← All use cases](../README.md)
- [Agentorum home](../../README.md)
- [Agent Ensemble as Super Intelligence](../agent-ensemble-superintelligence/) — text-based ensemble on GPQA Diamond benchmark
- [Full design specification](../../specs/design-spec.md)
