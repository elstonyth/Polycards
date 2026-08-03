# Plan 069: Restore the flagship customer money-path E2E (signup helper fills the required phone field)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 0f14da91..HEAD -- tests/e2e/helpers/storefront.ts tests/e2e/card-management.spec.ts src/components/AuthForm.tsx src/components/PhoneField.tsx`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW (test-only changes)
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `0f14da91`, 2026-08-02

## Why this matters

PR #311 (`25ad9b17`) added a **required phone field** to the signup modal. The
E2E signup helper never fills it, so the client-side validator blocks the form
before submission and the nightly's flagship spec — `customer.spec.ts`, the
only end-to-end coverage of signup → top-up → open → vault → sell-back — has
timed out on every run since 2026-08-01 (run 30714035144: 180s timeout on both
attempts; the five prior nightlies passed it in ~35s). Two secondary defects
compound it: the signup retry loop's worst-case budget (200s) exceeds the test
timeout (180s), so the helper's diagnostic error can never fire in CI, and
`card-management.spec.ts`'s cleanup test skips itself exactly when the
lifecycle test fails.

## Current state

- `tests/e2e/helpers/storefront.ts:44-48` — `submitSignup` fills only these
  fields, then submits:

  ```ts
  await page.fill('input[name="username"]', username);
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.fill('input[name="confirmPassword"]', password);
  await page.getByRole('button', { name: /create account/i }).click();
  ```

- `src/components/AuthForm.tsx:265-275` — signup mode renders
  `<PhoneField name="phone" ... required />`. `AuthForm.tsx:93-100` early-returns
  (sets a note, never calls the server action) when
  `!normalizePhone(form.get('phone'))`.
- `src/components/PhoneField.tsx` — the visible controls are a native
  `<select aria-label="Country code">` and an
  `<input aria-label="Phone number" type="tel" ...>`; the E.164 value rides in
  `<input type="hidden" name="phone" value={e164} />`. **You cannot
  `page.fill('input[name="phone"]', ...)` — that input is hidden.** Default
  country is `DEFAULT_PHONE_COUNTRY` from `src/lib/profile-validation.ts`
  (check its value; it is the country the plain national number below must be
  valid in).
- `tests/e2e/helpers/storefront.ts:79-88` — the retry loop:

  ```ts
  for (let attempt = 0; attempt < 5; attempt++) {
    await submitSignup(page, slug, username, email, password);
    if (await flippedToOpen(page, 12_000)) return;
    await page.waitForTimeout(8_000); // clear the short sign-in window
    await submitLogin(page, slug, email, password);
    if (await flippedToOpen(page, 12_000)) return;
    await page.waitForTimeout(8_000);
  }
  throw new Error('signup never completed — CTA never became "Open Pack"');
  ```

  Worst case 5 × (12+8+12+8)s = **200s** against `playwright.config.ts:19`
  `timeout: 180_000` — the throw at `:87` is unreachable in CI; failures
  surface as an opaque `Test timeout ... at helpers/storefront.ts:82`.

- `tests/e2e/card-management.spec.ts:139-144` — the cleanup test:

  ```ts
  test('deleting the card frees the product to be eligible again', async () => {
    test.skip(!lifecycleRan, 'lifecycle test skipped — no cleanup to verify');
  ```

  `lifecycleRan` flips true at `:59` only after the lifecycle test's fixture
  assertion passes — so a lifecycle _failure_ silently skips the cleanup check
  in exactly the run where cleanup is most in doubt. The `finally` block at
  `:131-136` runs the cleanup regardless, so the assertion is valid to run
  unconditionally. The comment at `:34-38` ("if it's absent both tests skip")
  is stale — round 8 converted the lifecycle test to hard-fail (`:50-58`).

## Commands you will need

| Purpose                                            | Command                                          | Expected on success      |
| -------------------------------------------------- | ------------------------------------------------ | ------------------------ |
| List specs parse-clean                             | `npx playwright test --list`                     | exit 0, all specs listed |
| Storefront typecheck                               | `npm run typecheck`                              | exit 0                   |
| Full live run (only if the stack is up — see STOP) | `npx playwright test tests/e2e/customer.spec.ts` | pass                     |

## Scope

**In scope** (the only files you should modify):

- `tests/e2e/helpers/storefront.ts`
- `tests/e2e/card-management.spec.ts`

**Out of scope**:

- `src/components/AuthForm.tsx`, `src/components/PhoneField.tsx` — the product
  behavior is correct; only the test helper is stale.
- `playwright.config.ts` — do not raise the global 180s timeout; fix the
  budget instead.
- Any other spec file.

## Git workflow

- Branch: `advisor/069-e2e-signup-phone`
- Conventional commits, e.g. `fix(e2e): fill the required signup phone field in the storefront helper`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Fill the phone field in `submitSignup`

In `tests/e2e/helpers/storefront.ts`, after the `confirmPassword` fill and
before the Create-account click, drive the **visible** phone input:

```ts
// PR #311 made the phone field required; PhoneField's E.164 value lives in a
// hidden input, so fill the visible national-number control instead.
await page.getByRole('textbox', { name: 'Phone number' }).fill('0123456789');
```

`0123456789` must normalize to a valid number for `DEFAULT_PHONE_COUNTRY`
(for `MY` it becomes `+60123456789`, a valid mobile). Verify the country by
reading `src/lib/profile-validation.ts`; if the default is not `MY`, pick a
valid national mobile number for that country instead.

Then add a guard so the _next_ required-field addition cannot silently re-dark
this path — after filling, before clicking submit:

```ts
// If the form gains another required field, fail HERE with a clear message
// instead of timing out 180s later.
const missing = await page
  .locator('form input[required]')
  .evaluateAll((els) =>
    els
      .filter((el) => !(el as HTMLInputElement).value)
      .map(
        (el) =>
          (el as HTMLInputElement).name || (el as HTMLInputElement).ariaLabel,
      ),
  );
if (missing.length) {
  throw new Error(
    `signup form has unfilled required fields: ${missing.join(', ')}`,
  );
}
```

**Verify**: `npx playwright test --list` → exit 0.

### Step 2: Bring the retry budget under the test timeout

Reduce the loop to 3 attempts (3 × 40s = 120s < 180s) and keep the
diagnostic throw reachable:

```ts
// 3 attempts × ~40s worst case = 120s, safely under the 180s test timeout so
// the diagnostic below can actually fire (5 × 40s = 200s could not).
for (let attempt = 0; attempt < 3; attempt++) {
```

Leave `login()` (4 × 20s = 80s) as is — it already fits.

**Verify**: `npx playwright test --list` → exit 0; arithmetic comment present.

### Step 3: Make the cleanup test self-sufficient

In `tests/e2e/card-management.spec.ts`:

- Delete the `lifecycleRan` flag (declaration at `:38`, assignment at `:59`,
  and the `test.skip(!lifecycleRan, ...)` line at `:140`). The lifecycle
  test's `finally` (`:131-136`) restores the pool and deletes the card even on
  failure, and `beforeAll` (`:40-45`) deletes any leftover card — so the
  eligibility assertion at `:142-143` is valid unconditionally.
- Update the stale comment at `:34-38`: the lifecycle test hard-fails (not
  skips) on a missing fixture since round 8; the cleanup test now always runs.

**Verify**: `npx playwright test --list` → exit 0;
`grep -n "lifecycleRan" tests/e2e/card-management.spec.ts` → no matches.

### Step 4: Live verification (conditional)

If the full stack is available (storefront :4000 standalone build, backend
:9000, admin :7000 — see `tests/e2e/README.md`), run:

`npx playwright test tests/e2e/customer.spec.ts` → pass.

If the stack is not available, note in your report that the first nightly
after merge is the runtime proof (`customer.spec.ts` must PASS, not time out)
— this mirrors the accepted round-8 plan-048 caveat.

## Test plan

This plan _is_ test code. New assertions: the required-field guard in
`submitSignup` (fails fast with field names) and the unconditional cleanup
eligibility assertion. Pattern for helper style: the existing functions in
`tests/e2e/helpers/storefront.ts`.

## Done criteria

- [ ] `submitSignup` fills the visible phone control and asserts no required
      field is left empty before submitting
- [ ] Retry loop worst case < 180s (3 attempts), with the arithmetic in a comment
- [ ] `grep -n "lifecycleRan" tests/e2e/card-management.spec.ts` → no matches
- [ ] Stale comment at `card-management.spec.ts:34-38` corrected
- [ ] `npx playwright test --list` exits 0
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:

- `AuthForm.tsx` no longer renders `PhoneField` in signup mode, or the field
  is no longer required (the premise changed).
- `DEFAULT_PHONE_COUNTRY` resolves to a country for which you cannot determine
  a valid national mobile number.
- A live run still times out in `signup()` after the phone fill — then the
  regression has a second cause; do not keep patching the helper.

## Maintenance notes

- Any future required signup field must be added to `submitSignup`; the new
  required-field guard turns that omission into an immediate named failure.
- Reviewer: check the phone number used is valid for the default country and
  that no product file was touched.
- Deferred: driving the country `<select>` (not needed while the default
  country accepts the test number).
