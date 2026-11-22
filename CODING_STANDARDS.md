# Coding standards

Judgement rules for reviewing a change. Each is the behaviour the code should show; a change that departs from one is a finding.

## A check can go red

Every test and QA check fails when the thing it guards is broken or missing: an empty list, a selector that matches nothing, a skipped fixture or a value never measured reads as a failure. An absence check stands beside a positive control that proves the element exists in the same run.

## One rule, one place

A pattern, list, threshold or condition is written once and read from there by everything that needs it, tests and QA scripts included.

## Unused code is deleted

Code that nothing calls, or that only its own tests call, is removed along with those tests; `npm run knip` and `npm run knip:prod` list it. Git history keeps it.

Example: `src/components/pack-flow/flow-address.ts` and its test went together once no page used them.

## A fix closes its whole ticket

A fix addresses every item its issue lists, or its description names each item left open and why.

Example: the change that moved the graded packs' geometry into `src/components/pack-3d/fixtures/` names the six packs it covers and states that the raw packs' comparisons still skip without the research folder.
