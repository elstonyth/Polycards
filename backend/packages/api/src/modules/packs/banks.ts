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
};

const bank = (
  id: string,
  name: string,
  legacy: GatewayBankCode | null,
  tgpay: GatewayBankCode | null,
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
});

export const MY_BANKS: readonly Bank[] = [
  bank('PHBMMYKL', 'Affin Bank', { code: 'MYAFBB', name: 'Affin Bank' }, { code: 'PHBMMYKL', name: 'Affin Bank Berhad' }),
  bank('AGOBMYKL', 'Agrobank', { code: 'MYAGRO', name: 'AgroBank' }, { code: 'AGOBMYKL', name: 'AGROBANK / BANK PERTANIAN MALAYSIA BERHAD' }),
  bank('MFBBMYKL', 'Alliance Bank', { code: 'MYABMB', name: 'Alliance Bank' }, { code: 'MFBBMYKL', name: 'Alliance Bank Malaysia Berhad' }),
  bank('RJHIMYKL', 'Al Rajhi Bank', { code: 'MYRJHI', name: 'ALRAJHI Bank' }, { code: 'RJHIMYKL', name: 'AL RAJHI BANKING & INVESTMENT CORPORATION (MALAYSIA) BERHAD' }),
  bank('ARBKMYKL', 'AmBank', { code: 'MYAMBB', name: 'Ambank' }, { code: 'ARBKMYKL', name: 'AmBank (M) Berhad' }),
  bank('BIMBMYKL', 'Bank Islam', { code: 'MYBIMB', name: 'Bank Islam Malaysia' }, { code: 'BIMBMYKL', name: 'Bank Islam Malaysia Berhad' }),
  bank('BKRMMYKL', 'Bank Rakyat', { code: 'MYBKRM', name: 'Bank Kerjasama Rakyat' }, { code: 'BKRMMYKL', name: 'Bank Kerjasama Rakyat Malaysia Berhad' }),
  bank('BMMBMYKL', 'Bank Muamalat', { code: 'MYBMMB', name: 'Bank Muamalat' }, { code: 'BMMBMYKL', name: 'Bank Muamalat (Malaysia) Berhad' }),
  bank('BSNAMYK1', 'Bank Simpanan Nasional (BSN)', { code: 'MYBSNB', name: 'Bank Simpanan National' }, { code: 'BSNAMYK1', name: 'Bank Simpanan Nasional Berhad' }),
  bank('CIBBMYKL', 'CIMB Bank', { code: 'MYCIMB', name: 'CIMB Bank Berhad' }, { code: 'CIBBMYKL', name: 'CIMB Bank Berhad' }),
  bank('CITIMYKL', 'Citibank', null, { code: 'CITIMYKL', name: 'Citibank Berhad' }),
  bank('HLBBMYKL', 'Hong Leong Bank', { code: 'MYHLBB', name: 'Hong Leong Bank Berhad' }, { code: 'HLBBMYKL', name: 'Hong Leong Bank Berhad' }),
  bank('HBMBMYKL', 'HSBC Bank', { code: 'MYHSBC', name: 'HSBC Bank' }, { code: 'HBMBMYKL', name: 'HSBC Bank Malaysia Berhad' }),
  bank('KFHOMYKL', 'Kuwait Finance House', null, { code: 'KFHOMYKL', name: 'Kuwait Finance House' }),
  bank('MBBEMYKL', 'Maybank', { code: 'MYMB2U', name: 'Maybank Berhad' }, { code: 'MBBEMYKL', name: 'Maybank / Malayan Banking Berhad' }),
  bank('OCBCMYKL', 'OCBC Bank', { code: 'MYOCBC', name: 'Overseas Chinese Banking Corporation Limited' }, { code: 'OCBCMYKL', name: 'OCBC Bank (Malaysia) Berhad' }),
  bank('PBBEMYKL', 'Public Bank', { code: 'MYPUBB', name: 'Public Bank Berhad' }, { code: 'PBBEMYKL', name: 'Public Bank Berhad' }),
  bank('RHBBMYKL', 'RHB Bank', { code: 'MYRHBB', name: 'RHB Bank Berhad' }, { code: 'RHBBMYKL', name: 'RHB Bank Berhad' }),
  bank('SCBLMYKX', 'Standard Chartered', { code: 'MYSTCB', name: 'Standard Chartered Bank' }, { code: 'SCBLMYKX', name: 'Standard Chartered Bank (Malaysia) Berhad' }),
  // Touch 'n Go eWallet keeps its slug id (saved accounts already carry it);
  // TGPay added a payout code for it after this table was first copied
  // (their payout-bank page, checked 2026-10-09).
  { ...bank('TNGMY', "Touch 'n Go eWallet", { code: 'MYTNGO', name: 'Touch N Go' }, { code: 'TNGDRMYKL', name: "Touch 'n Go" }), payoutMinRm: 100 },
  bank('UOVBMYKL', 'UOB', { code: 'MYUOBB', name: 'United Overseas Bank' }, { code: 'UOVBMYKL', name: 'United Overseas Bank (Malaysia) Berhad' }),
  // No TGPay payout code today (e-wallets, digital and foreign banks): kept so
  // a saved account under one still resolves and reads as "not available with
  // the current payout provider" instead of vanishing.
  bank('AEONMY', 'Aeon Bank', { code: 'ACDB', name: 'Aeon Bank' }, null),
  bank('MBSBMY', 'MBSB Bank', { code: 'AFBQ', name: 'MBSB Bank' }, null),
  bank('BIGPAYMY', 'BigPay', { code: 'BIGB', name: 'BigPay' }, null),
  bank('BOOSTMY', 'Boost', { code: 'BODE', name: 'Boost' }, null),
  bank('KAFMY', 'KAF Bank', { code: 'KAFD', name: 'KAF Bank' }, null),
  bank('SHOPEEPAYMY', 'ShopeePay', { code: 'MYARPY', name: 'Shopee Pay' }, null),
  bank('BOCMY', 'Bank of China', { code: 'MYBOCM', name: 'Bank Of China' }, null),
  bank('BOFAMY', 'Bank of America', { code: 'MYBOFA', name: 'Bank Of America' }, null),
  bank('JPMMY', 'JP Morgan', { code: 'MYCHAS', name: 'JP Morgan' }, null),
  bank('GXBANKMY', 'GX Bank', { code: 'MYGXSP', name: 'GX Bank Berhad' }, null),
  bank('MTRADEMY', 'Merchant Trade', { code: 'MYMSSH', name: 'Merchant Trade' }, null),
  bank('RYTMY', 'Ryt Bank', { code: 'SCCH', name: 'Ryt Bank' }, null),
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
const sgBank = (id: string, name: string, code: string, a3payName: string): Bank => ({
  id,
  name,
  codes: { a3pay: { code, name: a3payName } },
  legacyAliases: [],
});

export const SG_BANKS: readonly Bank[] = [
  sgBank('DBSSSGSG', 'DBS Bank', 'SDBS', 'DBS Bank Singapore'),
  sgBank('POSBSG', 'POSB', 'POSB', 'The Development Bank of Singapore'),
  sgBank('OCBCSGSG', 'OCBC Bank (SG)', 'OCBC', 'OCBC Bank'),
  sgBank('UOVBSGSG', 'UOB (SG)', 'UOB', 'United Overseas Bank'),
  sgBank('SCBLSGSG', 'Standard Chartered (SG)', 'SCBS', 'Standard Chartered Bank Singapore'),
  sgBank('CITISGSG', 'Citibank (SG)', 'CITIS', 'CitiBank Singapore'),
  sgBank('HSBCSGSG', 'HSBC (SG)', 'HSBCS', 'HSBC Bank Singapore'),
  sgBank('MBBESGSG', 'Maybank (SG)', 'MBBS', 'MayBank Singapore'),
  sgBank('CIBBSGSG', 'CIMB Bank (SG)', 'CIMB', 'CIMB Bank'),
  sgBank('RHBBSGSG', 'RHB Bank (SG)', 'RHB', 'RHB Bank'),
  sgBank('HLBBSGSG', 'Hong Leong Bank (SG)', 'HLB', 'HongLeong Bank'),
  sgBank('BKCHSGSG', 'Bank of China (SG)', 'BOC', 'Bank of China'),
  sgBank('ALLIANCESG', 'Alliance Bank (SG)', 'ABMB', 'Alliance Bank'),
  sgBank('TRUSTBANKSG', 'Trust Bank', 'TBL', 'Trust Bank'),
  sgBank('GXSSG', 'GXS Bank', 'GXS', 'GXS Bank'),
  sgBank('MARIBANKSG', 'MariBank', 'Maribank', 'Maribank'),
  // In A3Pay's live GetSupportedBankList (2026-10-12), not the handbook.
  sgBank('ANEXTSG', 'ANEXT Bank', 'SGANEXT', 'ANEXT Bank'),
  // PayNow by MOBILE number only: the account field is digits-only
  // (withdrawalDetailsError), so UEN/NRIC proxies cannot be saved. Wise,
  // LiquidPay and Dash are not offered — their payee identifiers are not
  // digit account numbers, so a saved one could never be paid.
  sgBank('PAYNOWSG', 'PayNow (mobile number)', 'PayNow', 'PayNow'),
];

/** The TGPay platform's sandbox (TGPay, The 7 Pay) accepts only this pair; it
 *  is a bank nowhere else. */
export const TGPAY_SANDBOX_BANK: Bank = bank(
  'DUMMYBANKVERIFIED',
  'Dummy Bank Verified (sandbox)',
  null,
  { code: 'DUMMYBANKVERIFIED', name: 'Dummy Bank Verified' },
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
for (const b of SG_BANKS) byAlias.set(b.id.toUpperCase(), b);

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
): GatewayBankCode | null {
  return findBank(alias)?.codes[gateway] ?? null;
}

/** Banks a gateway can pay to, in picker order (canonical ids, neutral names). */
export function banksFor(
  gateway: PaymentGateway,
  options: { sandbox?: boolean } = {},
): { bankCode: string; bankName: string }[] {
  const list = [...MY_BANKS, ...SG_BANKS]
    .filter((b) => b.codes[gateway])
    .map((b) => ({ bankCode: b.id, bankName: b.name }));
  if (isTgpayKind(gateway) && options.sandbox) {
    list.unshift({
      bankCode: TGPAY_SANDBOX_BANK.id,
      bankName: TGPAY_SANDBOX_BANK.name,
    });
  }
  return list;
}
