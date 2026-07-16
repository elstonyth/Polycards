# Playbooks — Higgsfield-class product features on SnapGen

Higgsfield's product skills (`higgsfield-product-photoshoot`, `higgsfield-marketplace-cards`, Marketing Studio) are thin CLI wrappers around a **private backend prompt enhancer** — mode-specific photography vocabulary and structural templates — submitted to the same base models SnapGen exposes (`gpt_image_2` ≙ `gpt-image`, `nano_banana_2` ≙ `image`, Kling/Seedance/Veo ≙ `video <family>`). SnapGen has no enhancer endpoint, so **this file IS the enhancer**: build the final prompt from the template for the matched mode — don't freehand it. Same model + same structural prompt = same quality class.

Shared rules (all playbooks):

- **Reference-led always.** Attach the real product/brand/presenter image with `--files` — never describe a product you have a photo of.
- **Finals on `gpt-image --mode high --resolution 2K`; drafts on `image` (nano-banana-2) at 1K.** Same split Higgsfield uses (photoshoot = GPT Image 2 at 2k; marketplace cards = nano_banana_2).
- **One job at a time; `--dry-run` on the first use of any new template.**
- **Variants vary ONE knob per run** (lighting, angle, palette, prop set) — that's exactly what Higgsfield's enhancer does across a pack; re-rolling an identical prompt just wastes credits.
- **Aspects are fixed enums** (verified against `openapi.json`). Playbook aspects assume `gpt-image` (`1:1 16:9 9:16 4:3 3:4 21:9 3:2 2:3`); when drafting on nano (`1:1 16:9 9:16 4:3 3:4` only) downgrade 3:2→4:3, 2:3→3:4, 21:9→16:9. Video: veo `16:9|9:16`; seedance `16:9|9:16|1:1|3:4|4:3|21:9`; kling `--aspect_ratio` (default 16:9); grok video/storyboard and meta take the words `landscape|portrait|square` instead.
- **Set consistency = attach the anchor.** Higgsfield "locks the visual system" server-side; do it client-side by attaching the approved first image (or its uuid via `--ref_history`/`--ref_histories`) to every subsequent generation + "same lighting, palette, and prop system".

## 1. Product photoshoot (≙ higgsfield-product-photoshoot)

Model: `gpt-image` (the literal same GPT Image 2), `--resolution 2K`. Before generating, settle (from context or ≤4 short questions, labeled options): how many, style/mood, where it'll be used, brand colors.

Pick the mode by intent (more specific wins; platform beats subject: "Pinterest pin of X on a counter" → moodboard_pin). Fill the skeleton's `[…]` slots from the **Vocabulary bank** below:

| Mode                          | Aspect        | Prompt skeleton (fill `[…]`, keep it tight)                                                                                                                                             |
| ----------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `product_shot`                | `1:1`         | `[product] on seamless [white/neutral/brand-color] studio background, soft diffused key light, faint contact shadow, straight-on catalog shot, tack sharp`                              |
| `lifestyle_scene`             | `4:3`/`3:2`   | `[product] in [environment: kitchen counter/café table/gym bench], natural [golden hour/morning window] light, shallow depth of field, candid editorial feel[, hands interacting]`      |
| `closeup_product_with_person` | `3:4`         | `tight crop of hands [holding/applying/demonstrating] [product], partial face, macro detail, soft window light, visible skin texture, 85mm`                                             |
| `moodboard_pin`               | `2:3`         | `[product] styled flat-lay vignette, [aesthetic: clean girl/cottagecore/quiet luxury/dark academia] mood, curated props, cohesive muted palette, Pinterest editorial`                   |
| `hero_banner`                 | `21:9`/`16:9` | `[product] hero composition, clear negative space on the [left/right] for headline copy, dramatic rim light, subtle gradient backdrop in [brand palette]`                               |
| `social_carousel`             | `1:1` ×N      | slide 1 from another mode's skeleton; slides 2+: attach slide 1 + `slide [N] of [M], same palette, lighting and prop system, [this slide's content]`                                    |
| `ad_creative_pack`            | per placement | one base skeleton; per variant change ONE of hook/angle/palette-accent; lock the system via slide-1-as-reference                                                                        |
| `virtual_model_tryout`        | `3:4`         | `[model archetype] wearing/using [product], [studio clean/outdoor natural/street style/editorial/home cozy], editorial fashion photography, [full body/three-quarter/waist up] framing` |
| `conceptual_product`          | `1:1`         | `[product] [levitating/mid-splash frozen motion/sculptural arrangement], surreal CGI studio look, dramatic single-source lighting, hyperreal detail`                                    |
| `restyle`                     | keep source   | attach the existing image, prompt ONLY the delta: `[seasonal/aesthetic] version, [what to preserve]`                                                                                    |

Typography on the image (headline, price flag) → route that variant to `nano-banana-pro` or keep `gpt-image` (both render text well; nano-2 doesn't).

### Vocabulary bank (playbooks 1, 2, 4)

The slot vocabulary Higgsfield's enhancer draws from. **Usage: fill each `[…]` slot with ONE phrase, at most 3 bank phrases per prompt** — stacking more re-creates the long-prompt distortion the skill warns about. Across a variant pack, a slot IS the one knob you vary.

| Slot | Options (typical use in parentheses) |
| --- | --- |
| Lighting | `soft diffused key light, faint contact shadow` (catalog default) · `hard directional sunlight, crisp cast shadows` (editorial pop) · `rim light against a dark backdrop` (premium/dramatic) · `golden-hour window light, long warm shadows` (lifestyle) · `even overcast north light` (true color — skincare, clinical) · `raking side light` (texture — knits, engraving, grain; detail_shot) · `glossy top light on black acrylic with mirror reflection` (beauty/tech) |
| Lens / camera | `50mm, straight-on, f/5.6` (catalog honesty) · `85mm, shallow depth of field` (isolation, closeups) · `35mm environmental framing` (lifestyle context) · `100mm macro` (detail_shot) · `low-angle hero perspective` (monumental) · `top-down flat-lay` (moodboard, whats_in_box) · `three-quarter 45° product angle` (multi_angle) |
| Surface / backdrop | `seamless [color] paper sweep` · `brushed concrete` · `travertine slab` · `warm oak tabletop` · `black acrylic, mirror reflection` · `washed linen with soft folds` · `smooth gradient backdrop in [brand palette]` |
| Palette mood | `muted earth tones, low saturation` · `high-key white with a single [brand color] accent` · `moody low-key, deep shadows` · `warm sunlit amber` · `clinical cool neutrals` · `saturated color-block` |
| Styling / props | `generous negative space, product alone` · `ingredient scatter echoing the contents` · `fresh botanicals and water droplets` (freshness) · `geometric display podium` · `soft-blurred lived-in background` (lifestyle depth) |
| Motion (video, playbook 4) | `slow push-in on the product` · `smooth orbit with parallax` · `rack focus from prop to product` · `hand enters frame and lifts the product` · `macro slider across the texture` · `whip-pan transition` (between storyboard scenes) |

Pairings that consistently work: catalog = soft key + 50mm + paper sweep; premium = rim light + black acrylic + moody low-key; freshness = overcast light + botanicals + cool neutrals; texture story = raking light + 100mm macro; UGC video = handheld + `hand enters frame` + natural indoor light.

**Grow the bank from winners:** when a run ships (asset lands in `public/images/`), fold the phrase that made it work back into the matching slot — that's how the enhancer's vocabulary was built, and it beats inventing options in the abstract. Retire phrases that repeatedly lose.

## 2. Marketplace listing cards (≙ higgsfield-marketplace-cards)

Models: main/lifestyle on `image` (nano-banana-2, what Higgsfield uses) or `gpt-image` for the hero; anything with in-image text (infographic, A+ modules) on `nano-banana-pro` or `gpt-image`. The "private compliance rules" are standard marketplace main-image rules — encoded here:

**Main image (compliance):** `[product] on pure white background (RGB 255,255,255), product fills ~85% of frame, entire product in frame, photorealistic, no text, no logos, no watermarks, no props, no people` — `--aspect_ratio 1:1`.

Generate the main image FIRST, then attach it as the reference to every secondary/A+ asset (consistency anchor).

| Asset               | Skeleton (attach main image + product photos)                                                                                                |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `infographic`       | `same product, callout composition: 3–4 short benefit labels with thin leader lines, clean sans-serif, brand accent color, white background` |
| `multi_angle`       | `same product from [front + back + 45°] in one grid composition, consistent studio lighting`                                                 |
| `detail_shot`       | `macro closeup of [the differentiating detail: texture/stitching/port/cap], soft raking light`                                               |
| `lifestyle`         | playbook 1 `lifestyle_scene` skeleton                                                                                                        |
| `whats_in_box`      | `neatly arranged flat-lay of package contents: [list], top-down, labeled, white background`                                                  |
| `aplus_hero_banner` | `wide brand banner, product hero + short tagline space, brand palette` (`16:9`)                                                              |
| `aplus_pain_points` | `split composition: [problem scenario] vs product solving it, short caption labels`                                                          |
| `aplus_features`    | `feature grid: [3–4 features] as icon + label tiles around the product`                                                                      |
| `aplus_ingredients` | `exploded arrangement of [ingredients/materials] around the product, labeled`                                                                |
| `aplus_efficacy`    | `before/after or stat-callout composition, clean clinical style`                                                                             |
| `aplus_how_to_use`  | `numbered 3-step usage sequence, same model/hands throughout`                                                                                |
| `aplus_endorsement` | `trust composition: product + rating stars/badge space + happy user vignette`                                                                |

Scope bundles mirror Higgsfield's: `main` (1) / `product-images` (main + infographic, multi_angle, detail_shot, lifestyle, whats_in_box) / `aplus` (main + 7 modules) / `full-set` (all 13). Sequential, one at a time, main first.

## 3. Character consistency (≙ Soul ID, partial)

SnapGen has no trained identity. The standard substitute gets most of the way:

1. Generate ONE canonical **character sheet** (front + three-quarter view in a single image, neutral light) and keep its file + uuid.
2. Attach the sheet to every generation (`--files sheet.png`, or `--ref_histories <sheet-uuid>` on nano / `--ref_history` on gpt-image) and prompt only the pose/scene/outfit delta.
3. Video: `--ref_images sheet.png` on seedance/kling; on veo use `--mode_image ingredient` (identity, not first-frame).
4. **Re-anchor from the sheet every time — never chain gen→gen→gen**, drift compounds. Honest ceiling: long sets drift more than a trained Soul ID; re-attach and restate distinguishing features (`same character: [2–3 fixed traits]`).

## 4. Ads / UGC (≙ Marketing Studio, lightweight)

Marketing Studio = product entity + avatar + hook prepended to the prompt + setting descriptor, assembled server-side. Client-side equivalent — assemble the same four blocks into one prompt:

- **Product**: attach 1–3 real product photos (`--files`).
- **Presenter**: attach a consistent presenter image (playbook 3) or one archetype clause.
- **Hook** (prepended line, it's prompt text not a param): `POV: you finally found […]` / `Stop scrolling if […]` / `I tested [X] for a week —`.
- **Setting**: one environment clause.
- **Brand kit substitute**: keep `docs/research/brand-kit.md` (palette hexes, font names, 3 tone words) and paste the palette line into prompts; attach the logo file when the mark must appear.

Routing: static ad → `gpt-image` (playbook 1 `ad_creative_pack`). Video ad with voice → `video kling --model kling-video-2-6 --mode professional_audio`. Motion-heavy product demo → `video seedance --model seedance-2 --ref_images product.png`. Synced-audio cinematic → `video veo --model veo-3.1`. Multi-scene ad → `storyboard` (2–10 scenes, ≤45s). Vertical social output: `--aspect_ratio 9:16` on kling/seedance/veo, `--aspect_ratio portrait` on grok/storyboard, `--orientation portrait` on meta.

Video prompts take one **Motion** phrase from the Vocabulary bank (playbook 1) — motion is the video-pack variant knob, the way lighting is for stills. Family-specific structure (kling's Scene→Action→Camera order, seedance timed multi-shot beats, veo's `SFX:`/quoted-dialogue audio cues, sora's beats-not-contract style): `prompt-engineering.md` → Video prompting.

Ad-mode vocabulary (≙ Marketing Studio's `--mode` presets — build the prompt around the matching register):

| Ad mode          | Vocabulary to anchor the prompt                                                        |
| ---------------- | -------------------------------------------------------------------------------------- |
| UGC              | handheld selfie framing, direct-to-camera, natural indoor light, casual authentic tone |
| How-to           | step-by-step demonstration, hands-on close-ups, clear beats for voice-over pacing      |
| Unboxing         | package opening on a desk/lap, reveal moment, tactile close-ups of contents            |
| Product showcase | clean rotating/hero product shots, studio lighting, space for spec callouts            |
| Product review   | presenter holding the product, honest-reaction tone, before/after beat                 |
| TV spot          | polished cinematic grade, wide establishing shot + product macro, brand end-card       |
| Virtual try-on   | model wearing/using the product, mirror or fit-check framing                           |

## Not replicable (missing modality, not a missing template)

3D mesh/GLB, audio/music/SFX/TTS, virality video analysis, generative reframe/draw-to-edit, website building — the public API has no endpoints for these; a prompt template can't add a modality. Partial local stand-ins: reframe-by-crop with ffmpeg (`ffmpeg -i in.mp4 -vf "crop=ih*9/16:ih"` for 9:16 from landscape); "edit the ending" ≈ `extend <family>` with a new prompt.
