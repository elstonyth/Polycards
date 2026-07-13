# Plan 043: Make reset-admin-password.ts recoverable (register/restore before delete)

> **Executor instructions**: This plan is **operator-applied, NOT for
> worktree-executor dispatch** — see "Why this is operator-applied" below.
> Whoever applies it: follow the steps, run the verification, do not improvise.
> Your reviewer maintains `plans/README.md` — do not edit it.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `38f7dbdd`, 2026-07-13
- **Execution mode**: operator-applied (untracked file; see below)

## Why this is operator-applied (not dispatched to a worktree executor)

`backend/packages/api/src/scripts/reset-admin-password.ts` is **untracked** in
git (`git status` shows it as `??`). A dispatched executor works in a worktree
branched from committed HEAD, which does **not** contain this file — so it
cannot fix it. Two clean paths, both the operator's call:

1. Apply the fix locally (this plan), keep the file untracked (it's personal
   prod-clone dev tooling).
2. Decide to commit the tooling first, then apply the fix — only if you want
   this script in the repo. That's a separate decision from the bug fix.

Either way the change is small and local. The plan documents the fix; the
operator decides whether it ever enters git.

## Why this matters

The script resets an existing admin's emailpass password after cloning the
prod DB into local dev. It currently **deletes the old emailpass identity
before registering the replacement** (`:38-48`). If `register` fails after the
delete, the admin is left with **no** emailpass identity — locked out until
the script is re-run. For the stated local-dev prod-clone workflow this is
trivially recoverable (re-run), so impact is low — but the ordering is a
foot-gun worth removing.

## Current state

`backend/packages/api/src/scripts/reset-admin-password.ts` (untracked), the
relevant block (`:34-52`):

```ts
const identities = await authService.listAuthIdentities(
  { provider_identities: { entity_id: email, provider: 'emailpass' } },
  { relations: ['provider_identities'] },
);
for (const identity of identities) {
  await authService.deleteAuthIdentities([identity.id]); // <-- delete FIRST
}

const { authIdentity, error } = await authService.register('emailpass', {
  body: { email, password },
});
if (error || !authIdentity) {
  logger.error(`RESET: emailpass register failed: ${error}`);
  return; // <-- admin now has NO identity
}
await authService.updateAuthIdentities({
  id: authIdentity.id,
  app_metadata: { user_id: user.id },
});
```

Constraint that forces some care: the emailpass provider keys on `email`
(`entity_id`), so a straight "register before delete" **fails** — the old
identity still occupies that email. The fix must therefore either (a) capture
the old identity, delete, register, and **restore the old one on register
failure**, or (b) use a direct password-update API if the installed
`@medusajs` auth module exposes one (check
`backend/node_modules/@medusajs/*` for an emailpass password-update/`setPassword`
method — if present, that avoids delete+register entirely and is the cleaner
fix).

## Commands you will need

| Purpose                 | Command (in `backend/packages/api`)                                                                       | Expected                                  |
| ----------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Typecheck               | `corepack yarn check-types`                                                                               | exit 0                                    |
| Run the script (manual) | `corepack yarn medusa exec ./src/scripts/reset-admin-password.ts` with `ADMIN_EMAIL`/`ADMIN_PASSWORD` set | logs "password updated"; admin can log in |

## Scope

**In scope**:

- `backend/packages/api/src/scripts/reset-admin-password.ts` only.

**Out of scope**:

- Any other script or module.
- `create-admin.ts` (the create-path sibling) — leave it.
- The decision to commit the file — separate from this fix.

## Steps

### Step 1: Prefer a direct password update if available

Search `backend/node_modules/@medusajs` for an emailpass password-update seam
(e.g. an `updateProvider`, `setPassword`, or a way to update the
provider-identity credential). If one exists, replace the delete+register
block with it — resetting the password in place, no delete window.

**Verify**: `corepack yarn check-types` → exit 0.

### Step 2: Otherwise, make delete+register recoverable

If no in-place update exists, restructure so a register failure doesn't strand
the admin: capture the old identity's data first; wrap the delete+register so
that on register failure you **re-create/restore the old identity** (or, at
minimum, delete only _after_ a successful register into a way that doesn't
collide — if the provider allows a transactional swap, use it). The invariant:
after the script exits (success or failure), the admin has exactly one working
emailpass identity.

**Verify**: `corepack yarn check-types` → exit 0. Manually run the script
against a local DB and confirm the admin can log in; then simulate a failure
path if feasible (e.g. a deliberately bad password that register rejects) and
confirm the admin is NOT locked out.

## Test plan

This is a dev-ops script with no existing unit harness; verification is the
manual run in Step 2 (happy path logs success + login works; failure path
leaves the admin able to log in with the old password). No new automated test
is expected for a local-only script (consistent with the repo's other
`scripts/*` which are not unit-tested).

## Done criteria

- [ ] `corepack yarn check-types` exits 0
- [ ] The script no longer deletes the only emailpass identity before the
      replacement is secured (verify by reading the reordered/rewritten block)
- [ ] Manual run: admin password resets and login works
- [ ] Only `reset-admin-password.ts` changed

## STOP conditions

- No in-place password-update API exists AND the auth module won't allow
  re-creating an identity with preserved data (restore path impossible) —
  report; the honest fallback is a clear log + non-zero exit warning the
  operator to immediately re-run, which is the current recoverable-by-rerun
  behavior made explicit.
- The file is not present in your working tree (you're in a worktree without
  it) — STOP; this plan is operator-applied, not for worktree dispatch.

## Maintenance notes

- If the operator decides to commit this tooling, do it in its own commit
  separate from the fix, and add a one-line note to the backend README's
  prod-clone runbook.
- Related: the seeded admin password is a known operator rotation item (see
  the plans/README round-4 operator reminders) — unrelated to this fix but
  same script family.
