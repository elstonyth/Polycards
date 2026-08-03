# Plan 074: No storefront mutation button can be stranded by a transport failure

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 0f14da91..HEAD -- "src/app/(account)" src/components/account/SettingsForm.tsx src/app/reset-password/ResetPasswordClient.tsx src/components/AuthForm.tsx`
> On a mismatch with the "Current state" excerpts, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M (mechanical, ~9 handlers, each needing its own copy string)
- **Risk**: LOW — adds `try/catch/finally` around code that already has an error slot; success path unchanged
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `0f14da91`, 2026-08-02

## Why this matters

The repo's server actions never throw by contract — every action in
`src/lib/actions/*.ts` returns a discriminated `{ ok: false, error }` — so
client handlers were written without `try/catch/finally`. But the action
**POST itself** can reject: offline, a proxy 502, or the classic "Failed to
find Server Action" when a deploy rotates action IDs under an open tab. In
those cases roughly nine handlers leave a permanently disabled button
("Saving…"/"Removing…"), show no message, and surface an unhandled promise
rejection. The notifications feed additionally keeps an optimistic "read"
state the server never saw. The correct pattern already exists in the same
files — this plan makes it universal.

## Current state

**Broken shape** — `src/app/(account)/addresses/AddressesClient.tsx:62-75`:

```ts
async function confirm() {
  setBusy(true);
  setError(null);
  const res = await deleteAddress(address.id);   // a throw skips everything below
  setBusy(false);
  if (!res.ok) { ... }
  onRemoved();
}
```

Same shape at `src/components/account/SettingsForm.tsx:32-38`
(`setBusy(true); const result = await updateProfile({...}); setBusy(false);`)
and `src/app/reset-password/ResetPasswordClient.tsx:62-68`
(`setBusy(true); const result = await resetPassword({ token, password }); setBusy(false);`).

**Notifications** — `src/app/(account)/notifications/NotificationsClient.tsx`:

- `:63` mount re-sync: `void getNotifications(page).then((r) => {...})` — no
  `.catch` (contrast the same action call with `.catch` in
  `src/components/NotificationBell.tsx:16-22`).
- `:71-84` `onRead`: optimistic mark-read, rollback only on `!r.ok` — a
  thrown `markRead(id)` leaves the row read forever, server unaware.
- `:86-110` `onClearAll`: `setClearing(true)` … `setClearing(false)` at the
  end of the function body, not in a `finally` — a throw skips it and
  permanently disables the button; rollback likewise only on `!r.ok`.

**The in-repo winner** — same file as the broken `confirm()`,
`AddressesClient.tsx:196-228` (`save()`):

```ts
setBusy(true);
setError(null);
try {
  ...await updateAddress/addAddress...
} catch {
  setError('Couldn’t save the address. Please try again.');
} finally {
  setBusy(false);
}
```

Also correct: `src/components/app-shell/TopUpSheet.tsx` (catch →
`setError('Something went wrong. Please try again.')`, `finally { setSubmitting(false) }`)
and `src/components/account/AvatarCropper.tsx:91-98`.

## Commands you will need

| Purpose    | Command         | Expected |
| ---------- | --------------- | -------- |
| Check      | `npm run check` | exit 0   |
| Unit tests | `npm test`      | all pass |

## Scope

**In scope**:

- `src/app/(account)/addresses/AddressesClient.tsx` (`confirm()` only — `save()` is already correct)
- `src/components/account/SettingsForm.tsx`
- `src/app/reset-password/ResetPasswordClient.tsx`
- `src/app/(account)/notifications/NotificationsClient.tsx` (three sites)
- Additional sites found by the Step-1 survey **matching the exact shape**
  (candidates named by the audit: `src/components/AuthForm.tsx`,
  `RequestDeliveryModal`, `OrdersClient`) — fix only handlers that call a
  server action with a busy-flag set outside `try/finally`
- One new test file (see Test plan)

**Out of scope**:

- `src/lib/actions/*` — the `{ok:false}` contract stands; do not make actions throw or not-throw.
- `TopUpSheet.tsx`, `AvatarCropper.tsx`, `AddressesClient.save()` — already correct.
- Any UI redesign of error placement; reuse each component's existing error slot.
- Retry logic — out of band; the user retries by clicking again once the button re-enables.

## Git workflow

- Branch: `advisor/074-action-transport-failures`
- Conventional commit, e.g. `fix(storefront): guard mutation handlers against server-action transport failures`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Survey and enumerate

Find every handler that sets a busy/pending flag and awaits a server action
without a wrapping `try`:

`grep -rn "setBusy(true)\|setSubmitting(true)\|setClearing(true)\|setPending(true)" src/ --include=*.tsx`

For each hit, read the enclosing function; list in your report which are
already guarded and which you will fix. Expect roughly: the four named files
plus AuthForm / RequestDeliveryModal / OrdersClient.

**Verify**: the list is written down before any edit.

### Step 2: Apply the `save()` shape to each unguarded handler

For each, wrap from the action call through the success handling in
`try { ... } catch { set<ErrorSlot>('<friendly copy>') } finally { set<Busy>(false) }`.
Copy strings: match each surface's existing tone (see `save()` and
`TopUpSheet` above); never surface raw error objects.

For `NotificationsClient` specifically:

- Mount effect: append `.catch(() => {})` with a one-line comment (transport
  failure keeps the server-rendered list — same posture as
  `NotificationBell.tsx:20-22`).
- `onRead`: wrap `markRead` in try/catch; the catch performs the same rollback
  as the `!r.ok` branch.
- `onClearAll`: move `setClearing(false)` into `finally`; the catch performs
  the same rollback as the `!r.ok` branch (reuse the `wasUnread` snapshot;
  leave `serverTotal` untouched on failure, per the comment at `:99-101`).

**Verify**: `npm run check` → exit 0.

### Step 3: Confirm no unguarded shape remains

`grep -rn -A2 "setBusy(true)" src/ --include=*.tsx` — every occurrence must
be immediately inside or followed by a `try` (manual read of each hit; state
the count in your report).

**Verify**: report lists each site as guarded.

## Test plan

- The rollback logic in `NotificationsClient` is the one genuinely
  behavioral piece. If the repo has a component/hook test harness precedent
  (check `src/**/__tests__/*.test.tsx` for any existing component test), add
  a test that renders the client with `markRead` mocked to reject and asserts
  the row returns to unread and no unhandled rejection escapes. If **no**
  component-test precedent exists, extract the rollback into a small pure
  helper (e.g. `rollbackRead(items, id)` beside the existing
  `displayUnreadTotal` helper) and unit-test that instead — do not introduce
  a new testing library for one test.
- `npm test` fully green either way.

## Done criteria

- [ ] Every handler from the Step-1 list wraps its action call in
      `try/catch/finally` with the busy-flag reset in `finally`
- [ ] `NotificationsClient`: mount `.catch`, `onRead`/`onClearAll` roll back
      on throw, `setClearing(false)` in `finally`
- [ ] New test (component or extracted-helper) covering the reject-rollback
- [ ] `npm run check` and `npm test` exit 0
- [ ] No files outside scope modified; `plans/README.md` row updated

## STOP conditions

- The Step-1 survey turns up **more than ~12** unguarded sites — the sweep is
  bigger than scoped; report the list instead of expanding silently.
- Any handler's control flow doesn't fit the `save()` shape without
  restructuring (e.g. multi-step wizards) — report that site, fix the rest.
- An existing test asserts the _unguarded_ behavior (unlikely; would indicate
  a deliberate design this audit missed).

## Maintenance notes

- New mutation handlers should copy `AddressesClient.save()`. If this class
  recurs after this sweep, consider a tiny `useActionCall` wrapper hook —
  deliberately not built now (premature until a third recurrence post-sweep).
- Reviewer: check copy strings match each surface's voice, and that no
  rollback path double-fires when `!r.ok` AND a later throw both occur (they
  can't — return after the `!r.ok` branch — but verify the edits kept that).
