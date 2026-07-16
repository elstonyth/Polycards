# Prompt Engineering

SnapGen serves the same model families as everyone else (Gemini "nano banana", GPT Image 2, Grok, Veo/Sora/Kling/Seedance). The prompting rules are the standard image/video rules — the failures below are ones that actually happened in this repo.

## Core rules

- **Short beats long.** Keep prompts ≈ under 200 tokens. Long, clause-stacked prompts distort. A tight `subject + setting + style + lighting` line beats a paragraph.
- **Concrete + sensory.** "brushed platinum sleeve, satin sheen, chamfered bevel, straight-on, soft studio light" — not "a nice premium frame."
- **Phrase positively.** "empty window, clean single border" beats "NO card, NO label, NO dividers, zero texture." Piles of negatives confuse more than they constrain.
- **One structural negative is fine** when there's no positive phrasing for it — e.g. a chroma-key `FLAT SOLID MAGENTA #FF00FF` window/background for later keying. Keep it to that; don't stack ten more.

## With a reference attached — prompt the DELTA

The single biggest failure: attaching a reference **and** writing a full description of what's already in it. The prose fights the image and the result comes out worse than the reference.

- Bad: `--files ref.png` + "a gold glitter holographic protector with rounded corners, rainbow inner lining, embossed bevel, PSA slab proportions, thick border…"
- Good: `--files ref.png` + "same protector style, empty window, no card inside"

State only what should change. The model already sees the rest. If output looks wrong and a reference exists, suspect a missing/ignored attachment before you touch the prompt.

## IP / trademark safety

Real characters and brand marks (Pokémon, PSA, a named athlete, a logo you don't own) risk an `ip_detected` / safety failure (status 3, wasted round-trip) and produce infringing art even when they slip through.

- For a slab mockup: "a graded trading-card slab, generic holo card" — don't name Pokémon or PSA.
- When brand identity IS the point, **attach our own brand asset** (`public/branding/polycards-logo.png`) with `--files` instead of describing someone else's.

## Model-specific notes (image)

- **nano-banana-2 / -pro** — Google's own guide: brief it **like a creative director in full sentences**, never tag soup (`dog, park, 4k, realistic`); short prompts (<~25 words) compose more accurately than paragraphs. If a result is ~80% right, **don't re-roll — iterate the specific change** referencing the previous gen (`--ref_histories <uuid>`): the model excels at conversational edits. Pro is the text/typography pick (rate-limited, see troubleshooting) and handles many references upstream — order matters, the first 2–3 refs carry the critical elements.
- **gpt-image** — OpenAI's guide: 1–3 clear sentences in the order **scene → subject → key details → constraints**, and **state the intended use** ("ad", "UI mock", "infographic") — it sets the polish register. Exact in-image copy goes **in quotation marks + ask for "verbatim" rendering**. `--mode high --resolution 2K/4K` for hero assets, `low/medium 1K` for drafts (low is often enough — cost scales steeply with mode·res).
- **grok-image** — cheapest; takes refs per the docs (`--files`/`--ref_history`, `--mode SPEED|QUALITY`) but fidelity is unproven here. Throwaway concepting first.
- **meta-image** — Meta AI; refs via `--files`/`--ref_history`, `--orientation` instead of aspect ratio. Untested here.

## Video prompting (per family)

Every family rewards director-language over adjective piles: camera behavior and motion live in the prompt, container values (duration/resolution/aspect) live in flags — prose like "make it longer" changes nothing.

- **veo** — five-part line: **shot composition + subject + action + setting + mood**; 100–150 words is the sweet spot, past ~175 the instructions conflict. veo-3.1 generates **synced audio from the prompt**: quote dialogue (`A woman says, "We have to leave now."`), label effects (`SFX: thunder cracks in the distance`), set the bed (`Ambient noise: quiet hum of a server room`).
- **kling** — strict order **Scene → Characters → Action → Camera → Audio/Style**, 20–50 precise words (a 300-word paragraph gets half-ignored). Describe camera behavior *over time* — `dolly push`, `whip-pan`, `shoulder-cam drift`, `crash zoom`, `snap focus`, "camera freezes when she pauses, resumes as she moves". Image-to-video: the ref is the anchor — prompt only how the scene *evolves*, never what's already in it.
- **seedance** — formula **Subject + Action + Environment + Camera + Lighting + Style**. Its superpower is **multi-shot in one prompt**: state shot count + total duration up top, then per-shot blocks or timed beats (`0–3s: extreme close-up on eyes widening; 3–7s: dolly out to a rooftop standoff`) — up to ~5 shots with hard cuts, or chain sequential beats with `›`. Division of labor: text defines the world, image refs lock identity, video refs guide movement, audio refs shape rhythm.
- **sora** — the prompt is a **wish list, not a contract**: 2–3 short beats in camera-team language; over-specifying reduces reliability. Dialogue goes in its **own block below the prose**. Shorter clips obey better — two 4s beats (generate + `extend`) beat one over-stuffed 10s ask. An image ref anchors the *first frame*; the text says what happens next.
- **grok / meta** — no official prompting guides; apply the kling rules (short, director-language, one motion idea per clip).

## Aspect ratio

`--aspect_ratio 1:1|16:9|9:16|4:3|3:4` (nano); gpt-image adds `21:9 3:2 2:3`; grok/meta use `--orientation landscape|portrait|square`. Pick the closest to the final crop; you'll usually crop precisely in post anyway. For a trading-card slab (`SLAB_ASPECT` ≈ 0.598) the nearest is `9:16` (0.5625), then hard-crop to the exact rect.

Sources for the per-model rules (2026-07): Google's [Veo 3.1 prompting guide](https://cloud.google.com/blog/products/ai-machine-learning/ultimate-prompting-guide-for-veo-3-1) and [Nano Banana Pro prompt tips](https://blog.google/products-and-platforms/products/gemini/prompting-tips-nano-banana-pro/), OpenAI's [image-gen prompting guide](https://developers.openai.com/cookbook/examples/multimodal/image-gen-models-prompting-guide) and [Sora 2 prompting guide](https://developers.openai.com/cookbook/examples/sora/sora2_prompting_guide), fal's [Kling 3.0 guide](https://blog.fal.ai/kling-3-0-prompting-guide/), Higgsfield's [Seedance prompting guide](https://higgsfield.ai/blog/seedance-prompting-guide).

## Iterate cheaply

Draft on `nano-banana-2` at `1K` (≈3 credits) or `gpt-image --mode medium --resolution 1K`. Only render the chosen direction at high res. Generate paid assets **one at a time**, never parallel batches (see `snapgen-one-at-a-time` memory).
