// Single source of truth for the public routes the QA gates scan.
//
// This list used to be duplicated in qa-csp.mjs and qa-a11y.mjs. When /claw was
// retired (2026-07-12) only one copy was updated, so qa-csp 404'd on its second
// route and exited 1 on every run for weeks — the gate looked "red as usual"
// instead of "broken". One list, both gates.
export const QA_ROUTES = ['/', '/leaderboard', '/how-it-works', '/about'];

// The CSP sweep additionally probes the pack catalog — the most script-heavy
// public surface (live backend fetch + client catalog), so an enforced policy
// gets validated against more than the static marketing pages. Derived from the
// list above, not a second literal. It is CSP-only on purpose: the a11y gate
// runs nightly in CI and /slots has not been audited for contrast/labels yet.
export const QA_CSP_ROUTES = [...QA_ROUTES, '/slots'];
