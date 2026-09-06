import type { PaymentGateway } from './gateway';

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
// 2026-09-05); the GlobePay365 GetSupportedBanks list as fetched 2026-09-05
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
};

const bank = (
  id: string,
  name: string,
  legacy: GatewayBankCode | null,
  tgpay: GatewayBankCode | null,
): Bank => ({
  id,
  name,
  codes: tgpay ? { tgpay } : {},
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
  bank('TNGMY', "Touch 'n Go eWallet", { code: 'MYTNGO', name: 'Touch N Go' }, null),
  bank('RYTMY', 'Ryt Bank', { code: 'SCCH', name: 'Ryt Bank' }, null),
];

/** TGPay's sandbox accepts only this pair; it is a bank nowhere else. */
export const TGPAY_SANDBOX_BANK: Bank = bank(
  'DUMMYBANKVERIFIED',
  'Dummy Bank Verified (sandbox)',
  null,
  { code: 'DUMMYBANKVERIFIED', name: 'Dummy Bank Verified' },
);

/**
 * The dummy bank is a payable destination only while TGPay's SANDBOX is the
 * configured base — on production it is a name nothing can pay to, so the
 * picker, the saved-account writer and the withdrawal precheck all refuse it
 * there (the adapter refuses it too, but that is after the debit).
 */
export function sandboxOnlyBank(
  alias: string,
  env: { TGPAY_API_BASE?: string } = process.env,
): boolean {
  return (
    findBank(alias)?.id === TGPAY_SANDBOX_BANK.id &&
    !/sandbox/i.test(env.TGPAY_API_BASE ?? '')
  );
}

const byAlias = new Map<string, Bank>();
for (const b of [...MY_BANKS, TGPAY_SANDBOX_BANK]) {
  byAlias.set(b.id.toUpperCase(), b);
  for (const c of Object.values(b.codes)) byAlias.set(c.code.toUpperCase(), b);
  for (const a of b.legacyAliases) byAlias.set(a.toUpperCase(), b);
}

/** Resolve a canonical id OR any gateway's code to the bank. Null if unknown. */
export function findBank(alias: string | null | undefined): Bank | null {
  if (typeof alias !== 'string') return null;
  return byAlias.get(alias.trim().toUpperCase()) ?? null;
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
  const list = MY_BANKS.filter((b) => b.codes[gateway]).map((b) => ({
    bankCode: b.id,
    bankName: b.name,
  }));
  if (gateway === 'tgpay' && options.sandbox) {
    list.unshift({
      bankCode: TGPAY_SANDBOX_BANK.id,
      bankName: TGPAY_SANDBOX_BANK.name,
    });
  }
  return list;
}
