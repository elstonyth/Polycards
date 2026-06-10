// Shared motion vocabulary, measured frame-by-frame from live phygitals.com.
// Source of truth: docs/research/components/motion-fidelity.spec.md (rAF captures in
// docs/research/openpack-live/ + motion-live/). Use these tokens instead of ad-hoc
// durations so every surface keeps the live site's exact feel.

/** packs drop off-screen when one is selected (live `pack-carousel-exit`, 0.48s) */
export const EASE_EXIT: [number, number, number, number] = [0.55, 0, 0.85, 0.4];
/** slab rise + card flip (live `swipe-card-back-first` / `swipe-card-flip`, 0.6s) */
export const EASE_RISE: [number, number, number, number] = [0.16, 1, 0.3, 1];
/** metadata rows / rarity pill pop with overshoot (live `swipe-suspense-*`) */
export const EASE_BACK: [number, number, number, number] = [0.34, 1.56, 0.64, 1];
/** Tailwind's default transition curve — live uses it for UI fades + hover zoom */
export const EASE_TW: [number, number, number, number] = [0.4, 0, 0.2, 1];

/** pack-select exit: +430px drop, fade toward 0.4 (then unmount) */
export const PACK_EXIT = { duration: 0.48, ease: EASE_EXIT } as const;
/** slab entrance: y 200→0 + fade-in */
export const SLAB_RISE = { duration: 0.6, ease: EASE_RISE } as const;
/** card flip-in (backface) */
export const CARD_FLIP = { duration: 0.6, ease: EASE_RISE } as const;

/** metadata suspense screen (delays in seconds, measured: rows 0.7s apart) */
export const META_LABEL_DELAYS = [0.2, 0.9, 1.6] as const;
export const META_VALUE_OFFSET = 0.1; // value follows its label by 100ms
export const META_PILL_DELAY = 2.6;
export const META_AUTO_ADVANCE_MS = 3600; // live flips to the card at ≈3.6s

/** hero carousel: ~650ms ease-out slides, theme swap every ≈4.5s */
export const HERO_SLIDE = { duration: 0.65, ease: "easeOut" } as const;
export const HERO_ROTATE_MS = 4500;

/** cylinder snap/shuffle spring: ≈0.5–0.6s settle, no visible overshoot */
export const CYL_SPRING = { type: "spring", stiffness: 240, damping: 32 } as const;
/** live drag ratio: 364px ≈ 120° → 0.33°/px */
export const DRAG_DEG_PER_PX = 0.33;
