# Real name + phone lock (welcome-pack anti-farm) — design

Date: 2026-10-06. Approved in chat by the operator the same day.

## Why

Operator report: people buy batches of Gmail accounts and farm the free welcome
pack. Ask: before the welcome pack can be claimed, the account must hold a
**verified phone** and a **real name**. The real name must be the name the
phone's Touch 'n Go eWallet account shows, so staff can check a suspicious big
hit by searching the phone number in TNG. Once verified, the phone cannot be
changed by the customer; once confirmed, the real name cannot either. Changes go
through customer service.

## Decisions (operator, 2026-10-06)

- **Every account without a real name is gated**, old customers included — a
  non-dismissable modal on the account pages, like the existing phone gate.
- **Email verification: not now.** Phone OTP is the one-person-one-account check.
- **CS changes phone / real name from the admin panel**, with a reason, audited.
- **Withdrawals are not gated** on the real name. Only the welcome pack is.

## Design

### Data

`customer_account_state` gains `real_name` (text, null) and
`real_name_set_at` (timestamptz, null). Written by the server only, not
`customer.last_name` (client-writable through `POST /store/customers/me`, and
Google fills it with `family_name`), and not metadata (reserved by
`rejectCustomerMetadata`).

The customer write is **set-once**: one conditional statement that matches
only while `real_name IS NULL`, so a double submit cannot overwrite. The admin
write overwrites and audits.

`admin_action_audit` gains actions `set_real_name` and `set_phone`
(entity_type `customer`). The CHECK is rewritten by migration.

### Real-name format

`normalizeRealName`: trim, collapse inner whitespace, 3–100 characters, Unicode
letters and combining marks, spaces, and `' - . @ / ,` (Malaysian names carry
`bin`, `a/l`, `@`). Stored as typed; staff compare case-insensitively. Shared by
the backend (authoritative) and the storefront (courtesy).

### Customer surfaces

- **Signup form:** a required "Full name" field. Before the OTP is sent, the
  form shows the name back for a double confirm ("can't be changed later, must
  match your TNG eWallet name"). After the account is created, the signup action
  calls `POST /store/customers/me/real-name`. If that call fails, the gate below
  catches the account.
- **Account gate:** `src/app/(account)/layout.tsx` mounts `RealNameModal` for
  any account without a real name, once the phone gate is not showing. The two
  never stack. It uses the same input → confirm → save flow, with Log out as
  the only other way out. Partner groups with `verification_exempt` skip it,
  the same as the phone gate.
- **Settings:** shows the real name read-only once set. Until then it has the
  entry → confirm flow.
- `GET /store/customers/me/account` adds `realName` (the customer's own) and
  `phoneVerified`.

### Phone lock

- `POST /store/phone-verification/change` refuses once `phone_verified_at` is
  set: "Your phone number is verified and can't be changed here. Contact
  customer service." Adding a first phone (Google signups, `PhoneOnboardingModal`)
  and verifying a legacy unverified number keep working. A legacy number on file
  can only be verified as it is; swapping it for a different number is refused
  ("old customers cannot change it either").
- Settings shows a verified phone read-only with no button. The Google-only
  "confirm the old number" step is dead and removed. So is the flag-off editable
  phone field.
- `POST /store/customers/me` refuses any `phone` key whatever the flag says.
  The signup-side flag (`PHONE_VERIFICATION_REQUIRED`) is untouched; it is the
  Twilio-outage rollback lever.

### Welcome-pack gate

`claimFreePackStep` runs after the frozen check and before the one-time claim,
so a refusal leaves the claim unspent. It requires `phone_verified_at` and
`real_name`, unconditionally: no flag and no partner exemption, because it is an
anti-farm business rule. `GET /store/free-pack` keeps `eligible` and adds
`missing: ('phone' | 'real_name')[]`. When something is missing, the pack page
replaces the open button with a "Complete verification to claim" link to
`/settings`.

### Customer service (admin)

- `POST /admin/customers/:id/real-name` `{ real_name, reason }`: overwrites,
  audited in the same transaction.
- `POST /admin/customers/:id/phone` `{ phone, reason }`: E.164, goes through
  `assertPhoneUnclaimed`, writes the number, keeps or stamps
  `phone_verified_at` (the CS agent vouches), audits, and emails the account a
  phone-changed notice. A socially engineered CS change leads straight to the
  phone password reset, so the owner must hear about it.
  `rejectAdminPhoneWrite` stays on the generic routes.
- Admin customer page: real name shown, plus "Edit real name" and "Change
  phone" actions. Players list: a real name column.

### PII

The real name never appears on public profiles, logs, Telegram or Discord
reports. `/privacy` lists it. CONTEXT.md documents the gate.

## Testing

- Unit: `normalizeRealName`; the phone-change route lock; the claim step gate
  (missing phone, missing name, both present); the admin routes' validation.
- Integration: set-once `setRealName` (second write refused, concurrent writes
  race to one winner); the migration SQL, run against a seeded temp DB; existing
  free-pack integration specs stamp phone + real name.
- Storefront vitest: the free-pack state mapper with `missing`; the real-name
  validator parity.
- Final `/code-review`. Then confirm explicitly that a brand-new emailpass signup
  and a brand-new Google signup cannot claim without a real name.
