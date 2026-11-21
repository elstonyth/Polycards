# Coding standards

Judgement rules for reviewing a change. Each is the behaviour the code should show; a change that departs from one is a finding.

## A check can go red

Every test and QA check fails when the thing it guards is broken or missing: an empty list, a selector that matches nothing, a skipped fixture or a value never measured reads as a failure. An absence check stands beside a positive control that proves the element exists in the same run.

Example: `return-visit` in `scripts/qa-home-stage.mjs` requires a visible tile in its samples, so a renamed `data-stage-tile` turns it red; `missing()` in `scripts/lib/qa-present.mjs` names a selector that matched nothing.

## One rule, one place

A pattern, list, threshold or condition is written once and read from there by everything that needs it, tests and QA scripts included.

Example: `scripts/qa-home-flow.mjs` reads `LAP_TRIM_MARGIN` from `src/components/pack-stage/stage-flow.ts` and throws when it cannot, so the checks follow the page's own margin.

## Unused code is deleted

Code that nothing calls, or that only its own tests call, is removed along with those tests. Git history keeps it.

Example: `src/components/pack-flow/flow-address.ts` and its test went together once no page used them.

## A fix closes its whole ticket

A fix addresses every item its issue lists, or its description names each item left open and why.

Example: the change that moved the graded packs' geometry into `src/components/pack-3d/fixtures/` names the six packs it covers and states that the raw packs' comparisons still skip without the research folder.
