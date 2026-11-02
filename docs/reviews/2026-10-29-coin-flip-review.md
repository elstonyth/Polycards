# Coin flip implementation and visual review

Worktree: `codex/vault-coin-flip`. Scope: the complete coin-flip implementation and its current uncommitted changes.

## Review coverage

Five code reviewers examined settlement/ledger concurrency; authenticated API and migrations; storefront state/recovery; motion/rendering; and admin configuration/history. Three visual reviewers examined design/UX, responsive/accessibility code, and the running desktop/mobile demo.

No actionable settlement or API authorization defect was found. This is review evidence, not a guarantee of absence of defects. The settlement implementation retains server-side outcomes, atomic multi-card acceptance, idempotency, eligibility/version revalidation and audited admin settings.

## Findings addressed

- **P2 — Late acceptance after navigation:** refresh the wallet on a verified late response and keep the unseen round's recovery marker. A regression reproduces leaving before acceptance resolves.
- **P2 — History could reveal a result early:** pause requests and pagination during submission/animation, discard pending responses, then resume after reveal.
- **P2 — Background admin refresh discarded drafts:** preserve the editing baseline and audit reason; show revision conflict for explicit reload. Keep cached editors on refetch errors.
- **P2 — Motion assets could leave an unresponsive/wrong-face coin:** explicitly report renderer readiness and retain the receipt's static face while assets or WebGL are unavailable. Tap settlement remains available.
- **P2 — Fallback copy promised unavailable dragging:** show tap-only instructions until the scene is usable; describe selected, flying and landed states accurately for assistive technology.
- **P2 — Mobile hierarchy and result clarity:** compact the header and Head/Tail choices, retain card context, expose the complete result amount/receipt on mobile, and label the commitment as "Your call" separately from the landed face.
- **P2 — Weak landing framing:** move the settled camera closer without changing the flight camera or physical traces. Check drag/camera bounds at narrow layouts.
- **P3 — Instanced edge cleanup:** release the coin's instance resources explicitly.
- **P3 — Outdated published-odds help:** describe the stored published reference without claiming it appears on the storefront.
- **P3 — Picker and large-value polish:** use a dark native scrollbar and allow uncapped money strings to wrap within their containers.

## Design direction

The visual reviewers recommended a targeted redesign, preserving Coin B, the existing Nekst/Geist typography, grayscale surfaces, Vault picker and physical animation. The result should be exciting through readable card art, a recognizable coin landing and a clear credit receipt. No extra steps, automatic restaking, artificial countdown pressure or decorative coin showers were added.

## Verification

- **29 frontend tests passed** across flow/recovery, history, renderer readiness, physical motion and action contracts. The readiness cases include delayed assets, renderer failure and reduced-motion transitions.
- **8 focused admin tests passed**, including preserving edits on background revision changes and cached data on refetch failure. Targeted lint, formatting and TypeScript checks passed, as did `git diff --check`.
- **Storefront and admin production builds passed.** Admin used its pinned backend TypeScript 5.9.3 and Vite binaries; the root TypeScript 6 installation rejects the admin's existing `baseUrl` setting. Existing large-chunk/Mercur plugin warnings remain. The storefront's first build returned the existing dependency security advisory; the unchanged retry succeeded. No dependencies or security protections were changed.
- **Final built-preview browser checks passed:** mobile Head win at 100% actual odds; mobile Tail loss at 0%; desktop Tail win via diagonal native mouse drag at 100%. Faces, credit, card retention/forfeiture and receipts agreed. Selected cards remained visible; the preceding history and balance remained unchanged during flight. Final mobile and desktop console warning/error lists were empty.
- **Responsive checks passed:** 393px mobile, a narrow 332px viewport with 319px content width, and desktop. The narrow layout has no horizontal overflow; its short 692px height requires ordinary vertical scrolling to the main action. The modal's card selection and footer remain usable.
- The visual reviewer independently approved all seven final screenshots, including desktop idle and Tail landing: **no further redesign needed for the reviewed states**. Baseline live interaction was performed by that reviewer; final live interaction was performed by the primary agent because the reviewer's browser session was unavailable on follow-up.

The prior all-rate validation covered **122 backend unit tests and 40 database tests**, including 400 deterministic threshold settlements for all whole-number rates from 0% through 100% and both selected sides; the reviewed backend implementation has not changed in this pass. Those suites were not repeated solely for this visual/frontend review.

Screenshot evidence is saved under `C:/Users/PC/.codex/visualizations/2026/10/27/01a17ec0-733c-75c2-a497-5b35fc5aeb45/`: `coin-review-mobile-after.png`, `coin-review-mobile-win-after.png`, `coin-review-mobile-loss-after.png`, `coin-review-narrow-after.png`, `coin-review-picker-after.png`, `coin-review-desktop-after.png` and `coin-review-desktop-tail-after.png`.

Implementation references: [React effect cleanup](https://react.dev/reference/react/useEffect), [Three.js InstancedMesh disposal](https://threejs.org/docs/pages/InstancedMesh.html#dispose), [pointer capture](https://developer.mozilla.org/en-US/docs/Web/API/Element/setPointerCapture).

## Remaining release checks

Physical iOS/Android touch and GPU calibration remain. Local browser scenarios use disposable demo credits/cards; database settlement tests run separately. This pass does not deploy, migrate the live database or enable production coin flips. When merging with the separate stock/GRN branch, retain both `goods_receive_note` and `coin_flip_config` in every applicable audit CHECK migration.
