import { createHash } from 'node:crypto';
import { keccak_256 } from '@noble/hashes/sha3';
import type { PaymentGateway } from './gateway';
import { isTgpayKind, tgpayEnvName } from './tgpay-client';

// Gateway-neutral bank registry (plan 130 §bank preservation).
//
// A customer's saved payout destination names a BANK, not a gateway's code
// for that bank. Saved accounts store the canonical `id` below; each gateway
// adapter translates it to its own code (and, where the gateway insists, its
// own spelling of the name) at payout time. Switching gateways therefore
// never invalidates a saved account — at worst a bank is "not available with
// the current payout provider" until a gateway that supports it is active.
//
// Canonical ids are the bank's SWIFT/BIC where TGPay publishes one, else a
// stable uppercase slug (the withdrawal validator only admits [A-Z0-9]{2,20}).
// Rows and metadata written before this file carry the retired GlobePay365
// gateway's codes (MYMB2U for Maybank, …); they are kept as LEGACY ALIASES
// so `findBank` still resolves every saved account written under it, and a
// customer never re-enters a bank because the gateway changed.
//
// Sources: TGPay "Malaysia bank SWIFT codes (payout)" (sandbox docs,
// 2026-09-05; Touch 'n Go added from the production docs 2026-10-09); the GlobePay365 GetSupportedBanks list as fetched 2026-09-05
// (aliases only).

export type GatewayBankCode = { code: string; name: string };

export type Bank = {
  /** Canonical, gateway-neutral id. What saved accounts and rows store. */
  id: string;
  /** Neutral display name for pickers and statements. */
  name: string;
  /** Per-gateway code + the exact name that gateway pairs with it. */
  codes: Partial<Record<PaymentGateway, GatewayBankCode>>;
  /** Codes of retired gateways that older rows may still carry. */
  legacyAliases: readonly string[];
  /**
   * This destination's own payout floor, RM, on top of the gateway's band.
   * Touch 'n Go: TGPay refused every TNG payout under ~RM 70 on 2026-10-09
   * ("No payout provider is available for this order") while paying RM 313,
   * so the floor is RM 100 until TGPay states the real limit.
   */
  payoutMinRm?: number;
  /**
   * Account-number lengths verified against bank guidance or settled payouts.
   * Unset = unavailable for payouts; never infer a country from length.
   */
  accountLengths?: readonly number[];
  /** Additional format rule for non-bank identifiers, such as PayNow mobile. */
  accountPattern?: string;
  accountHint?: string;
  /**
   * Env var that must be "true" before this bank is paid out to (read per
   * call). While it is off the bank behaves as if no gateway had a code for
   * it: out of the picker, saved accounts "not available", refused before any
   * debit. Unset = always on.
   */
  payoutSwitch?: string;
  /**
   * A crypto wallet, not a bank: the "account number" is a wallet address in
   * this chain's format (walletAddressValid), and there is no holder name —
   * the gateway takes the customer id in its place.
   */
  wallet?: WalletChain;
};

export type WalletChain = 'tron' | 'evm';

const bank = (
  id: string,
  name: string,
  legacy: GatewayBankCode | null,
  tgpay: GatewayBankCode | null,
  accountLengths?: readonly number[],
): Bank => ({
  id,
  name,
  // The 7 Pay is a white-label of TGPay's platform and publishes the same
  // SWIFT table (docs/payments/the7pay-api.md). The test-only 'fake' gateway
  // (fake-gateway.ts) pays to exactly what TGPay pays to, so a spec that
  // selects it takes the SAME supported/unsupported branches as production
  // instead of finding every saved account unpayable.
  codes: tgpay ? { tgpay, the7pay: tgpay, fake: tgpay } : {},
  legacyAliases: legacy ? [legacy.code] : [],
  ...(accountLengths ? { accountLengths } : {}),
});

// UOB Malaysia IBG/DuitNow receiving current, savings and e-wallet accounts:
// https://www.uob.com.my/assets/web-resources/business/pdf/ibg-duitnow-participating-bank.pdf
// Sources and exceptions: docs/payments/bank-account-validation.md.
export const MY_BANKS: readonly Bank[] = [
  bank('PHBMMYKL', 'Affin Bank', { code: 'MYAFBB', name: 'Affin Bank' }, { code: 'PHBMMYKL', name: 'Affin Bank Berhad' }, [12]),
  bank('AGOBMYKL', 'Agrobank', { code: 'MYAGRO', name: 'AgroBank' }, { code: 'AGOBMYKL', name: 'AGROBANK / BANK PERTANIAN MALAYSIA BERHAD' }, [16]),
  bank('MFBBMYKL', 'Alliance Bank', { code: 'MYABMB', name: 'Alliance Bank' }, { code: 'MFBBMYKL', name: 'Alliance Bank Malaysia Berhad' }, [15]),
  bank('RJHIMYKL', 'Al Rajhi Bank', { code: 'MYRJHI', name: 'ALRAJHI Bank' }, { code: 'RJHIMYKL', name: 'AL RAJHI BANKING & INVESTMENT CORPORATION (MALAYSIA) BERHAD' }, [15]),
  bank('ARBKMYKL', 'AmBank', { code: 'MYAMBB', name: 'Ambank' }, { code: 'ARBKMYKL', name: 'AmBank (M) Berhad' }, [13]),
  bank('BIMBMYKL', 'Bank Islam', { code: 'MYBIMB', name: 'Bank Islam Malaysia' }, { code: 'BIMBMYKL', name: 'Bank Islam Malaysia Berhad' }, [14]),
  bank('BKRMMYKL', 'Bank Rakyat', { code: 'MYBKRM', name: 'Bank Kerjasama Rakyat' }, { code: 'BKRMMYKL', name: 'Bank Kerjasama Rakyat Malaysia Berhad' }, [10, 12]),
  bank('BMMBMYKL', 'Bank Muamalat', { code: 'MYBMMB', name: 'Bank Muamalat' }, { code: 'BMMBMYKL', name: 'Bank Muamalat (Malaysia) Berhad' }, [14]),
  bank('BSNAMYK1', 'Bank Simpanan Nasional (BSN)', { code: 'MYBSNB', name: 'Bank Simpanan National' }, { code: 'BSNAMYK1', name: 'Bank Simpanan Nasional Berhad' }, [16]),
  bank('CIBBMYKL', 'CIMB Bank', { code: 'MYCIMB', name: 'CIMB Bank Berhad' }, { code: 'CIBBMYKL', name: 'CIMB Bank Berhad' }, [10, 14]),
  bank('CITIMYKL', 'Citibank', null, { code: 'CITIMYKL', name: 'Citibank Berhad' }, [9, 10, 11, 12, 13, 14, 15, 16]),
  bank('HLBBMYKL', 'Hong Leong Bank', { code: 'MYHLBB', name: 'Hong Leong Bank Berhad' }, { code: 'HLBBMYKL', name: 'Hong Leong Bank Berhad' }, [11, 13]),
  bank('HBMBMYKL', 'HSBC Bank', { code: 'MYHSBC', name: 'HSBC Bank' }, { code: 'HBMBMYKL', name: 'HSBC Bank Malaysia Berhad' }, [12, 13, 14, 15, 17]),
  bank('KFHOMYKL', 'Kuwait Finance House', null, { code: 'KFHOMYKL', name: 'Kuwait Finance House' }, [12]),
  bank('MBBEMYKL', 'Maybank', { code: 'MYMB2U', name: 'Maybank Berhad' }, { code: 'MBBEMYKL', name: 'Maybank / Malayan Banking Berhad' }, [12]),
  bank('OCBCMYKL', 'OCBC Bank', { code: 'MYOCBC', name: 'Overseas Chinese Banking Corporation Limited' }, { code: 'OCBCMYKL', name: 'OCBC Bank (Malaysia) Berhad' }, [9, 10, 11, 12, 13, 14, 15, 16, 17]),
  bank('PBBEMYKL', 'Public Bank', { code: 'MYPUBB', name: 'Public Bank Berhad' }, { code: 'PBBEMYKL', name: 'Public Bank Berhad' }, [10]),
  bank('RHBBMYKL', 'RHB Bank', { code: 'MYRHBB', name: 'RHB Bank Berhad' }, { code: 'RHBBMYKL', name: 'RHB Bank Berhad' }, [14]),
  bank('SCBLMYKX', 'Standard Chartered', { code: 'MYSTCB', name: 'Standard Chartered Bank' }, { code: 'SCBLMYKX', name: 'Standard Chartered Bank (Malaysia) Berhad' }, [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]),
  // Touch 'n Go eWallet keeps its slug id (saved accounts already carry it).
  // TGPay payout code from their payout-bank page (2026-10-09). OFF unless
  // TNG_PAYOUTS_ENABLED=true: TGPay's TNG route refused 97 of 110 payouts in
  // the week to 2026-10-14 ("No payout provider is available for this order")
  // and customers retried up to 16 times a day. Turn it on once TGPay confirms
  // the route (set it on the backend service and worker; the app redeploys).
  { ...bank('TNGMY', "Touch 'n Go eWallet", { code: 'MYTNGO', name: 'Touch N Go' }, { code: 'TNGDRMYKL', name: "Touch 'n Go" }, [12]), payoutMinRm: 100, payoutSwitch: 'TNG_PAYOUTS_ENABLED' },
  bank('UOVBMYKL', 'UOB', { code: 'MYUOBB', name: 'United Overseas Bank' }, { code: 'UOVBMYKL', name: 'United Overseas Bank (Malaysia) Berhad' }, [7, 9, 10, 11, 12, 13, 14, 17]),
  // No TGPay payout code today (e-wallets, digital and foreign banks): kept so
  // a saved account under one still resolves and reads as "not available with
  // the current payout provider" instead of vanishing.
  bank('AEONMY', 'Aeon Bank', { code: 'ACDB', name: 'Aeon Bank' }, null, [13]),
  bank('MBSBMY', 'MBSB Bank', { code: 'AFBQ', name: 'MBSB Bank' }, null, [16]),
  bank('BIGPAYMY', 'BigPay', { code: 'BIGB', name: 'BigPay' }, null, [14]),
  bank('BOOSTMY', 'Boost', { code: 'BODE', name: 'Boost' }, null, [12]),
  bank('KAFMY', 'KAF Bank', { code: 'KAFD', name: 'KAF Bank' }, null, [10]),
  bank('SHOPEEPAYMY', 'ShopeePay', { code: 'MYARPY', name: 'Shopee Pay' }, null),
  bank('BOCMY', 'Bank of China', { code: 'MYBOCM', name: 'Bank Of China' }, null, [13, 15]),
  bank('BOFAMY', 'Bank of America', { code: 'MYBOFA', name: 'Bank Of America' }, null, [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]),
  bank('JPMMY', 'JP Morgan', { code: 'MYCHAS', name: 'JP Morgan' }, null, [10, 11, 12, 13, 14, 15, 16, 17]),
  bank('GXBANKMY', 'GX Bank', { code: 'MYGXSP', name: 'GX Bank Berhad' }, null, [11, 13, 14]),
  bank('MTRADEMY', 'Merchant Trade', { code: 'MYMSSH', name: 'Merchant Trade' }, null, [12]),
  bank('RYTMY', 'Ryt Bank', { code: 'SCCH', name: 'Ryt Bank' }, null, [10]),
];

/**
 * Singapore payout destinations, paid through A3Pay (SGD). Codes and names
 * from A3Pay's live GetSupportedBankList (read 2026-10-12, 21 entries) —
 * prefer it over the handbook appendix, which lacks ANEXT. Canonical ids are SWIFT where the bank has a Singapore one, else
 * a slug ending in SG — never a bare A3Pay code, because several of those
 * (UOB, OCBC, CIMB, RHB, HLB, BOC) name a bank that ALSO exists in Malaysia,
 * and a saved Malaysian account must never resolve to its Singapore namesake
 * — which is also why their codes are NOT lookup aliases (see byAlias). DBS
 * and POSB are one bank with one SWIFT but two A3Pay codes, so POSB gets its
 * own slug.
 */
const sgBank = (
  id: string,
  name: string,
  code: string,
  a3payName: string,
  accountLengths?: readonly number[],
): Bank => ({
  id,
  name,
  codes: { a3pay: { code, name: a3payName } },
  legacyAliases: [],
  ...(accountLengths ? { accountLengths } : {}),
});

// ABS FAST receiving-account structures, 1 April 2026 (pp. 4–7):
// https://abs.org.sg/docs/library/2026-04-01-fast-fact-sheet.pdf
// Include published virtual-account lengths for OCBC, UOB and HSBC.
export const SG_BANKS: readonly Bank[] = [
  sgBank('DBSSSGSG', 'DBS Bank', 'SDBS', 'DBS Bank Singapore', [10]),
  sgBank('POSBSG', 'POSB', 'POSB', 'The Development Bank of Singapore', [9]),
  sgBank('OCBCSGSG', 'OCBC Bank (SG)', 'OCBC', 'OCBC Bank', [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]),
  sgBank('UOVBSGSG', 'UOB (SG)', 'UOB', 'United Overseas Bank', [7, 9, 10, 11, 12, 13, 14, 17, 18]),
  sgBank('SCBLSGSG', 'Standard Chartered (SG)', 'SCBS', 'Standard Chartered Bank Singapore', [10]),
  sgBank('CITISGSG', 'Citibank (SG)', 'CITIS', 'CitiBank Singapore', [10]),
  sgBank('HSBCSGSG', 'HSBC (SG)', 'HSBCS', 'HSBC Bank Singapore', [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]),
  sgBank('MBBESGSG', 'Maybank (SG)', 'MBBS', 'MayBank Singapore', [11]),
  sgBank('CIBBSGSG', 'CIMB Bank (SG)', 'CIMB', 'CIMB Bank', [10]),
  sgBank('RHBBSGSG', 'RHB Bank (SG)', 'RHB', 'RHB Bank', [11]),
  sgBank('HLBBSGSG', 'Hong Leong Bank (SG)', 'HLB', 'HongLeong Bank', [18]),
  sgBank('BKCHSGSG', 'Bank of China (SG)', 'BOC', 'Bank of China', [15]),
  // Unverified: retained for historical rows, unavailable until A3Pay supplies its account format.
  sgBank('ALLIANCESG', 'Alliance Bank (SG)', 'ABMB', 'Alliance Bank'),
  sgBank('TRUSTBANKSG', 'Trust Bank', 'TBL', 'Trust Bank', [10]),
  sgBank('GXSSG', 'GXS Bank', 'GXS', 'GXS Bank', [10, 11]),
  sgBank('MARIBANKSG', 'MariBank', 'Maribank', 'Maribank', [9]),
  // In A3Pay's live GetSupportedBankList (2026-10-12), not the handbook.
  sgBank('ANEXTSG', 'ANEXT Bank', 'SGANEXT', 'ANEXT Bank', [11]),
  // PayNow by MOBILE number only: the account field is digits-only
  // (withdrawalDetailsError), so UEN/NRIC proxies cannot be saved. Wise,
  // LiquidPay and Dash are not offered — their payee identifiers are not
  // digit account numbers, so a saved one could never be paid.
  {
    ...sgBank('PAYNOWSG', 'PayNow (mobile number)', 'PayNow', 'PayNow', [7, 8, 9, 10, 11, 12, 13, 14, 15]),
    accountPattern: '^[1-9][0-9]{6,14}$',
    accountHint: 'Enter the mobile number linked to PayNow, with country code for overseas numbers (digits only).',
  },
];

/**
 * USDT payout wallets, paid through GlobePay365 (USDT). Their payout codes
 * from the API doc (2026-10-12): USDTTRC for a TRC20 wallet, USDTERC for an
 * ERC20 one; the account number is the wallet address. Registered by
 * canonical id only, like the Singapore banks.
 */
const usdtWallet = (
  id: string,
  name: string,
  code: string,
  gp365Name: string,
  wallet: WalletChain,
): Bank => ({
  id,
  name,
  codes: { gp365: { code, name: gp365Name } },
  legacyAliases: [],
  wallet,
  // One fixed address length per chain. The shape here is only the form's
  // first check; walletAddressValid (checksums) is the real gate.
  ...(wallet === 'tron'
    ? {
        accountLengths: [34],
        accountPattern: '^T[1-9A-HJ-NP-Za-km-z]{33}$',
        accountHint: 'Paste your TRC20 (Tron) address: it starts with T and is 34 characters long.',
      }
    : {
        accountLengths: [42],
        accountPattern: '^0x[0-9a-fA-F]{40}$',
        accountHint: 'Paste your ERC20 (Ethereum) address: it starts with 0x and is 42 characters long.',
      }),
});

export const USDT_WALLETS: readonly Bank[] = [
  usdtWallet('USDTTRC20', 'USDT · TRC20 (Tron)', 'USDTTRC', 'USDT-TRC20', 'tron'),
  usdtWallet('USDTERC20', 'USDT · ERC20 (Ethereum)', 'USDTERC', 'USDT-ERC20', 'evm'),
];

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Decode(text: string): Buffer | null {
  let n = BigInt(0);
  for (const ch of text) {
    const digit = BASE58.indexOf(ch);
    if (digit < 0) return null;
    n = n * BigInt(58) + BigInt(digit);
  }
  const hex = n.toString(16);
  const body = n === BigInt(0) ? Buffer.alloc(0) : Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex');
  const zeros = /^1*/.exec(text)?.[0].length ?? 0;
  return Buffer.concat([Buffer.alloc(zeros), body]);
}

const sha256 = (data: Buffer): Buffer => createHash('sha256').update(data).digest();

/**
 * Is this a well-formed address on the chain? A payout to a mistyped address
 * cannot be recalled, so the checksum is verified where the chain has one:
 *   - Tron: base58check (0x41 + 20 bytes + 4 checksum bytes).
 *   - EVM: EIP-55 — the case of each letter encodes keccak-256 of the
 *     lowercase address, so a mixed-case address with a typo fails. An
 *     address in ONE case carries no checksum (EIP-55 says so; some wallets
 *     show it that way) and is accepted on shape alone.
 */
export function walletAddressValid(chain: WalletChain, address: string): boolean {
  if (chain === 'evm') {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return false;
    const hex = address.slice(2);
    if (hex === hex.toLowerCase() || hex === hex.toUpperCase()) return true;
    const hash = Buffer.from(keccak_256(hex.toLowerCase())).toString('hex');
    return [...hex].every(
      (ch, i) =>
        /[0-9]/.test(ch) ||
        (parseInt(hash[i], 16) >= 8) === (ch === ch.toUpperCase()),
    );
  }
  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) return false;
  const raw = base58Decode(address);
  if (!raw || raw.length !== 25 || raw[0] !== 0x41) return false;
  return sha256(sha256(raw.subarray(0, 21))).subarray(0, 4).equals(raw.subarray(21));
}

/** The TGPay platform's sandbox (TGPay, The 7 Pay) accepts only this pair; it
 *  is a bank nowhere else. */
export const TGPAY_SANDBOX_BANK: Bank = bank(
  'DUMMYBANKVERIFIED',
  'Dummy Bank Verified (sandbox)',
  null,
  { code: 'DUMMYBANKVERIFIED', name: 'Dummy Bank Verified' },
  [12],
);

/**
 * The dummy bank is a payable destination only while `gateway`'s SANDBOX is
 * its configured base — on production it is a name nothing can pay to, so the
 * picker, the saved-account writer and the withdrawal precheck all refuse it
 * there (the adapter refuses it too, but that is after the debit). A gateway
 * outside the TGPay family (the test-only fake) is judged by TGPay's base.
 */
export function sandboxOnlyBank(
  alias: string,
  env: Partial<Record<string, string>> = process.env,
  gateway: PaymentGateway = 'tgpay',
): boolean {
  const base = env[tgpayEnvName(isTgpayKind(gateway) ? gateway : 'tgpay', 'API_BASE')];
  return (
    findBank(alias)?.id === TGPAY_SANDBOX_BANK.id &&
    !/sandbox/i.test(base ?? '')
  );
}

const byAlias = new Map<string, Bank>();
for (const b of [...MY_BANKS, TGPAY_SANDBOX_BANK]) {
  byAlias.set(b.id.toUpperCase(), b);
  for (const c of Object.values(b.codes)) byAlias.set(c.code.toUpperCase(), b);
  for (const a of b.legacyAliases) byAlias.set(a.toUpperCase(), b);
}
// Singapore banks resolve by canonical id ONLY. Their A3Pay codes are bare
// names (CIMB, UOB, OCBC, RHB, HLB, BOC…) that a Malaysian account written by
// hand or by an older client could plausibly carry; registering them as
// aliases would silently re-home that account to Singapore. The adapter maps
// id -> A3Pay code through gatewayBankCode, which needs no alias.
for (const b of [...SG_BANKS, ...USDT_WALLETS]) byAlias.set(b.id.toUpperCase(), b);

/** Resolve a canonical id OR any gateway's code to the bank. Null if unknown. */
export function findBank(alias: string | null | undefined): Bank | null {
  if (typeof alias !== 'string') return null;
  return byAlias.get(alias.trim().toUpperCase()) ?? null;
}

/** The bank's own payout floor (RM), or null when only the gateway's applies. */
export function bankPayoutMinRm(alias: string | null | undefined): number | null {
  return findBank(alias)?.payoutMinRm ?? null;
}

/** Canonical id for any alias, or null if the bank is unknown. */
export function canonicalBankCode(alias: string): string | null {
  return findBank(alias)?.id ?? null;
}

/**
 * The code (and paired name) a gateway wants for a bank. Null when that
 * gateway cannot pay to the bank — the adapter turns that into a definite
 * refusal, which refunds.
 */
export function gatewayBankCode(
  alias: string,
  gateway: PaymentGateway,
  env: Partial<Record<string, string>> = process.env,
): GatewayBankCode | null {
  const bank = findBank(alias);
  if (!bank || payoutUnavailable(bank, env)) return null;
  return bank.codes[gateway] ?? null;
}

/** Unverified account formats never become payable, even with a gateway code. */
function payoutUnavailable(
  bank: Bank,
  env: Partial<Record<string, string>>,
): boolean {
  return (
    !bank.accountLengths?.length ||
    (bank.payoutSwitch !== undefined &&
      env[bank.payoutSwitch]?.trim().toLowerCase() !== 'true')
  );
}

/** Banks a gateway can pay to, in picker order (canonical ids, neutral names). */
export function banksFor(
  gateway: PaymentGateway,
  options: { sandbox?: boolean; env?: Partial<Record<string, string>> } = {},
): { bankCode: string; bankName: string }[] {
  const env = options.env ?? process.env;
  const list = [...MY_BANKS, ...SG_BANKS, ...USDT_WALLETS]
    .filter((b) => b.codes[gateway] && !payoutUnavailable(b, env))
    .map((b) => ({ bankCode: b.id, bankName: b.name }));
  if (
    isTgpayKind(gateway) &&
    options.sandbox &&
    !payoutUnavailable(TGPAY_SANDBOX_BANK, env)
  ) {
    list.unshift({
      bankCode: TGPAY_SANDBOX_BANK.id,
      bankName: TGPAY_SANDBOX_BANK.name,
    });
  }
  return list;
}
