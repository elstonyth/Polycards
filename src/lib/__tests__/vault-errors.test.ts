import { describe, it, expect } from 'vitest';
import { friendlyError } from '@/lib/errors';
import { VAULT_RULES, VAULT_FALLBACK } from '@/lib/vault-errors';
import { isPhoneGateError } from '@/lib/phone-gate';

// Contract test for the same message-substring coupling as delivery-errors:
// @medusajs/js-sdk's FetchError keeps only message/status, so there is no code
// to match and the client matches backend TEXT. The strings below are the
// literal ones the backend throws — a reword breaks a test instead of silently
// degrading the UI.
//
// The ordering case is the reason this file exists. Shipped 2026-08-04: the
// gateway refusal contains the word "amount", the broad /amount/i rule sat
// above it, and a customer's valid RM 50 top-up was reported as a malformed
// amount while the gateway's actual refusal never surfaced.
const map = (msg: string) =>
  friendlyError(new Error(msg), VAULT_RULES, VAULT_FALLBACK);

describe('VAULT_RULES backend-message contract', () => {
  it('reports a gateway refusal as a gateway problem, not a bad amount', () => {
    // packs/gateway-deposit.ts, the GatewayError branch.
    const refusal =
      'We could not start your top-up. Please try a different amount or payment method.';
    expect(map(refusal)).toBe(
      'The payment gateway could not start this top-up, and nothing was charged. Please try a different amount, or try again later.',
    );
    // The precise regression: it must NOT fall through to the amount rule,
    // which is what a re-sort of the table would reintroduce.
    expect(map(refusal)).not.toBe(
      'Enter a valid amount (up to RM 10,000, whole cents).',
    );
  });

  it('still maps genuine amount-validation messages to the amount copy', () => {
    // packs/topup.ts topUpAmountError — narrowing the catch-all must not
    // disable it.
    expect(map('Amount must be greater than zero.')).toBe(
      'Enter a valid amount (up to RM 10,000, whole cents).',
    );
    expect(map('Amount must be at most RM 10,000 per top-up.')).toBe(
      'Enter a valid amount (up to RM 10,000, whole cents).',
    );
  });

  it('does not tell a customer to pick a payment method this table cannot see', () => {
    // Held when TopUpSheet had no picker; still holds now that it has one.
    // How many channels are offered is a per-request decision
    // (DEPOSIT_METHODS_ENABLED), so a static rule cannot promise there is
    // another one — and when there is, the tiles are right above this error.
    expect(map('We could not start your top-up.')).not.toMatch(
      /payment method/i,
    );
  });

  it('keeps the withdrawal rules ahead of the broad ones', () => {
    // The backend's band message carries the active gateway's own figures,
    // so it must reach the customer unchanged.
    expect(map('Withdrawals must be between RM 50 and RM 30,000.')).toBe(
      'Withdrawals must be between RM 50 and RM 30,000.',
    );
    expect(map('Top-ups must be between RM 50 and RM 10,000.')).toBe(
      'Top-ups must be between RM 50 and RM 10,000.',
    );
    const refused =
      'Your withdrawal was refused by the payment provider and your balance has been returned. Check your bank details are correct — if they are, contact support rather than retrying.';
    expect(
      map('Your withdrawal was refused by the payment provider and…'),
    ).toBe(refused);
    // The pre-095 backend wording still maps, because a storefront deploy and
    // a backend deploy are two different rollouts and the older message can
    // arrive after this one ships.
    expect(map('We could not start your withdrawal.')).toBe(refused);
  });

  it('passes an empty-payout-wallet refusal through instead of blaming the bank details', () => {
    // packs/gateway-withdrawal.ts, the TGPAY_PAYOUT_FLOAT_EMPTY branch. Our
    // TGPay payout wallet was short on 2026-09-29 and the "check your bank
    // details" copy sent a customer through nine attempts and three accounts.
    const floatEmpty =
      'Withdrawals are temporarily unavailable on our side and your balance has been returned. Your bank details are fine — there is no need to change them. Please try again later.';
    expect(map(floatEmpty)).toBe(floatEmpty);
    expect(map(floatEmpty)).not.toMatch(/check your bank details/i);
  });

  it("passes the Touch 'n Go no-provider refusal through so it can name the bank fallback", () => {
    // packs/gateway-withdrawal.ts: TGPay refused every TNG payout from
    // 2026-10-09 17:12 with "No payout provider is available for this order".
    const tngDown =
      "Touch 'n Go withdrawals are temporarily unavailable from our payment provider. Your balance has been returned. Please withdraw to a bank account for now.";
    expect(map(tngDown)).toBe(tngDown);
  });

  it('passes the bank no-provider refusal through instead of blaming the bank details', () => {
    // packs/gateway-withdrawal.ts: TGPay refused every bank payout from
    // 2026-10-20 17:40 with "No payout provider is available for this order",
    // and the "check your bank details" copy sent customers retrying 4–6 times.
    const noProvider =
      'Withdrawals are temporarily unavailable from our payout partner. Your balance has been returned and your bank details are fine. Please try again later.';
    expect(map(noProvider)).toBe(noProvider);
    expect(map(noProvider)).not.toMatch(/check your bank details/i);
  });

  it('points an unverified customer at the screen that clears the gate', () => {
    // Action-neutral copy: the same guard fires on topup AND withdrawal
    // (2026-08-05), so the message must not name either one.
    expect(map('Verify your phone number before continuing.')).toBe(
      'Verify your phone number in Account settings before continuing.',
    );
    // ...and the copy must stay recognisable to PhoneGateAction, which turns
    // that sentence into the button that goes there. Matching display text is
    // the only handle it has (the action returns a plain string), so a reword
    // that drops the phrase would silently remove the button.
    expect(
      isPhoneGateError(map('Verify your phone number before continuing.')),
    ).toBe(true);
    expect(isPhoneGateError(map('kaboom'))).toBe(false);
  });

  // The kill switch is the documented incident response for a dead gateway
  // (GATEWAY_ENABLED=false, an env flip with no deploy), and the 2026-08-05
  // gateway outage is the case it was built for. Until this rule existed the
  // switch was self-defeating: startDeposit's deliberate, operator-
  // chosen message matched NO rule and was flattened into VAULT_FALLBACK —
  // "Something went wrong. Please try again." So the one control we have for
  // "stop customers retrying a gateway that cannot succeed" told them to retry.
  it('surfaces the top-ups-disabled kill switch instead of the generic fallback', () => {
    // packs/gateway-deposit.ts (gatewayEnabled false) and
    // api/store/credits/deposit/route.ts (notify/return URL missing) both
    // throw this exact string.
    const paused = 'Top-ups are temporarily unavailable.';
    expect(map(paused)).not.toBe(VAULT_FALLBACK);
    expect(map(paused)).toBe(
      'Top-ups are paused right now — nothing was charged. Please try again later.',
    );
    // The whole point of the switch is to stop the retry loop, so the copy
    // must not invite an immediate retry the way the transient-refusal copy does.
    expect(map(paused)).not.toMatch(/in a moment/i);
    // The rule is deliberately case-insensitive, unlike a literal compare: this
    // matches backend TEXT, and a reword that only changes capitalisation must
    // not silently drop the customer back onto the generic fallback.
    expect(map('Top-Ups Are Temporarily Unavailable.')).toBe(map(paused));
  });

  it('passes every withdrawal refusal through verbatim, never the generic retry', () => {
    // The literal backend strings. Before 2026-10-03 every one of these fell
    // to VAULT_FALLBACK, so a customer short of playthrough was told to retry.
    const literals = [
      // withdrawable.ts withdrawalGateError — freeze, no top-up, locked, cap
      'Withdrawals are unavailable while your account is under review. Contact support.',
      'Top up at least once to unlock deliveries. To withdraw, you also need to use all your money for packs.',
      "Withdrawals unlock once you've used RM 10.55 more on packs. Then your balance, except bonus credit, can be withdrawn.",
      // the #793 wording (deploy skew), then the plain cap
      'Top up at least once to unlock withdrawals and deliveries.',
      'You can withdraw up to RM 28.40 right now. The other RM 10.55 is for opening packs.',
      'Nothing is withdrawable yet. Your RM 60.00 is for opening packs.',
      'You can withdraw up to RM 12.34 right now.',
      // the pre-2026-10-14 wording, still matched
      'RM 5.00 of your deposits must be spent on packs before you can withdraw.',
      // service.ts withdrawForCashout
      'Daily withdrawal limit reached. You can withdraw RM 100.00 more today.',
      'This withdrawal is no longer open, so nothing was debited. Start a new one.',
      // customer-group-guards.ts WITHDRAWALS_BLOCKED_MESSAGE
      'Withdrawals are not available on this account.',
      // saved-accounts.ts resolveWithdrawalDestination
      'Select a saved bank account.',
      'This bank account was saved before withdrawal checks were added. Remove it and save it again to use it.',
      'This bank account is not available for withdrawals yet — try again in about 3 hours.',
      // withdraw/accounts route: one bank account, one Polycards account
      'This bank account is already linked to another Polycards account. Withdraw to a bank account in your own name, or contact support if this is a mistake.',
      // gateway-withdrawal.ts startWithdrawal / withdrawalDetailsError
      'This bank account is not available with the current payout provider. Pick another saved account, or try again later.',
      'Add an email address to your account before withdrawing.',
      'Choose a bank from the list.',
      'Enter a valid account number (digits only).',
      "That looks like a card number. Enter your bank account number instead — it's in your banking app or on your statement, not on the card.",
      'Maybank account numbers are 12 digits. Check the number in your banking app.',
      'CIMB Bank account numbers are 10 or 14 digits. Check the number in your banking app.',
      'Enter the account holder name exactly as the bank has it.',
      'Enter the mobile number linked to PayNow, with country code for overseas numbers (digits only).',
      'Withdrawals to Alliance Bank (SG) are unavailable. Choose another bank.',
    ];
    for (const msg of literals) expect(map(msg)).toBe(msg);
  });

  it('passes regional-rail and wallet refusals through — never the wrong "amount" copy', () => {
    // The literal backend strings (gateway-deposit.ts, gateway-withdrawal.ts,
    // payment-fx.ts, the deposit route). The first one carries the word
    // "amount", which the broad /amount/ rule would rewrite.
    const literals = [
      'The exchange rate just changed. Check the new amount and try again.',
      'Withdrawals to this bank must come to between SGD 30 and SGD 10,000 (RM 90 is SGD 28.03).',
      'Withdrawals to this bank must come to between USDT 10 and USDT 5,000 (RM 40 is USDT 8.88).',
      'Withdrawals to this bank are temporarily unavailable on our side — nothing was taken from your balance. Your bank details are fine. Please try again later.',
      'SGD payments are paused right now — please try again shortly.',
      'USDT payments are paused right now — please try again shortly.',
      'SGD top-ups are not available right now.',
      'Enter the name on the bank account you are paying from.',
      // The pending-cap refusal (gateway-deposit.ts): fell to the generic
      // "Something went wrong" and hid why every retry failed.
      'You have several top-ups still waiting for payment. Finish one, or wait a few minutes before starting another.',
      'USDT top-ups are not available right now.',
      'That is not a valid TRC20 (Tron) address. Copy it exactly from your wallet: it starts with T and is 34 characters long.',
      'That is not a valid ERC20 (Ethereum) address. Copy it exactly from your wallet: it starts with 0x, and capital letters matter.',
    ];
    for (const msg of literals) expect(map(msg)).toBe(msg);
  });

  it('falls back for an unrecognised message', () => {
    expect(map('kaboom')).toBe(VAULT_FALLBACK);
  });
});
