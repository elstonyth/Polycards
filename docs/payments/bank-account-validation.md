# Payout account validation — Malaysia and Singapore

Checked 2026-10-18 against the bank registry in `backend/packages/api/src/modules/packs/banks.ts`. Rules below concern numeric current/savings receiving accounts, excluding credit cards, loans and hire purchase. They validate format, not account existence, ownership or actual payout acceptance.

## Sources

- [O: OCBC IBG account structures](https://www.ocbc.com.my/assets/pdf/MY/Velocity/IBG%20Product%20Offering%20and%20Account%20Structure.pdf), effective 2023-10-27. Bank-published payment guidance; dated and subject to change.
- [U: UOB IBG and DuitNow account lengths](https://www.uob.com.my/assets/web-resources/business/pdf/ibg-duitnow-participating-bank.pdf), undated current document retrieved 2026-10-18. Includes Ryt/KAF Digital and both bank and wallet destinations. UOB warns that partner-bank information is general guidance.
- [R: Bank Rakyat system-upgrade FAQ](https://www.bankrakyat.com.my/uploads/content-downloads/file_20240429183110.pdf), October 2020 upgrade, questions 14–17: new 10-digit accounts; old 12-digit accounts remain valid until further notice.
- [M: Maybank transfer help for OCBC Malaysia](https://www.maybank2u.com.my/mbb/m2u/m1102/m2uInterbankAccountLength.do?selectedBankOid=36891), undated, retrieved 2026-10-18: funds-transfer numbers are 9–17 digits.

## Payable bank registry

Confidence: **high** means matching bank-published payment tables, not direct verification of every issuing bank's internal account system. **Qualified** marks a broad corporate range or conflicting older guidance. No universal prefix was documented for these destinations; do not invent prefix restrictions.

| Registry ID | Bank | Allowed digit counts | Evidence | Confidence |
| --- | --- | --- | --- | --- |
| PHBMMYKL | Affin | 12 | O | High |
| AGOBMYKL | Agrobank | 16 | O | High |
| MFBBMYKL | Alliance | 15 | O | High |
| RJHIMYKL | Al Rajhi | 15 | O | High |
| ARBKMYKL | AmBank | 13 | O | High |
| BIMBMYKL | Bank Islam | 14 | O | High |
| BKRMMYKL | Bank Rakyat | 10, 12 | R | High |
| BMMBMYKL | Bank Muamalat | 14 | O | High |
| BSNAMYK1 | BSN | 16 | O | High |
| CIBBMYKL | CIMB | 10, 14 | O | High |
| CITIMYKL | Citibank | 9–16 | O | Qualified |
| HLBBMYKL | Hong Leong | 11, 13 | O | High |
| HBMBMYKL | HSBC | 12, 13, 14, 15, 17 | O | Qualified |
| KFHOMYKL | Kuwait Finance House | 12 | O | High |
| MBBEMYKL | Maybank | 12 | O | High |
| OCBCMYKL | OCBC | 9–17 | M | Qualified |
| PBBEMYKL | Public Bank | 10 | O | High |
| RHBBMYKL | RHB | 14 | O | High |
| SCBLMYKX | Standard Chartered | 5–17 | O | Qualified |
| UOVBMYKL | UOB | 7, 9, 10, 11, 12, 13, 14, 17 | O | High |

Ranges include every integer in the range. The current/savings union matters: HSBC savings is 12; Standard Chartered personal accounts are 12 but corporate accounts are 5–17. Citibank's UOB row describes corporate accounts. OCBC's own 2023 sheet says 10–17; UOB and Maybank both allow 9–17, so excluding 9 risks rejecting supported transfers.

## Wallet and inactive legacy registry

[UOB's current table](https://www.uob.com.my/assets/web-resources/business/pdf/ibg-duitnow-participating-bank.pdf) covers these numeric receiving accounts. Availability remains a separate gateway policy; adding a format must not enable a disabled route.

| Registry ID | Destination | Digits | Status/qualification |
| --- | --- | --- | --- |
| TNGMY | Touch 'n Go | 12 | DuitNow account; existing payout switch still applies |
| AEONMY | AEON Bank | 13 | No current registry payout code |
| MBSBMY | MBSB | 16 | No current registry payout code |
| BIGPAYMY | BigPay | 14 | No current registry payout code |
| BOOSTMY | Boost | 12 | Legacy identity ambiguous; UOB lists both Boost wallet and Boost Bank as 12 |
| KAFMY | KAF Digital | 10 | No current registry payout code |
| SHOPEEPAYMY | ShopeePay | Unverified | Proxy-only in UOB table; no numeric account rule |
| BOCMY | Bank of China | 13, 15 | No current registry payout code |
| BOFAMY | Bank of America | 5–17 | Corporate range; no current registry payout code |
| JPMMY | JP Morgan | 10–17 | No current registry payout code |
| GXBANKMY | GX Bank | 11, 13, 14 | No current registry payout code |
| MTRADEMY | Merchantrade | 12 | No current registry payout code |
| RYTMY | Ryt Bank | 10 | No current registry payout code |

## Implementation implications

- Keep all account numbers as strings, including leading zeros.
- The existing 6-digit generic minimum conflicts with published 5-digit corporate accounts.
- A 16-digit number passing Luhn is not sufficient evidence of a card: Agrobank and BSN legitimately use 16 digits. Published account lengths must take precedence over that heuristic.
- Unknown/unverified bank formats should not silently receive a generic permissive validator. Keep unsupported destinations unavailable until a usable format and gateway contract are verified.
- Bank-specific prefix/checksum/ownership verification was not established. Do not claim these checks or infer Malaysia/Singapore from number length alone.

## Singapore

The [ABS FAST account-structure guide, 1 April 2026](https://abs.org.sg/docs/library/2026-04-01-fast-fact-sheet.pdf), pages 4–7, gives the receiving account lengths. Current/savings and published virtual accounts are included; credit-card and loan account numbers are excluded.

| Registry ID | Bank | Digits |
| --- | --- | --- |
| DBSSSGSG | DBS | 10 |
| POSBSG | POSB | 9 |
| OCBCSGSG | OCBC | 10–19, including virtual accounts |
| UOVBSGSG | UOB | 7, 9, 10, 11, 12, 13, 14, 17, 18 |
| SCBLSGSG | Standard Chartered | 10 |
| CITISGSG | Citibank | 10 |
| HSBCSGSG | HSBC | 7–18, including virtual accounts |
| MBBESGSG | Maybank | 11 |
| CIBBSGSG | CIMB | 10 |
| RHBBSGSG | RHB | 11 |
| HLBBSGSG | Hong Leong | 18 |
| BKCHSGSG | Bank of China | 15 |
| TRUSTBANKSG | Trust | 10 |
| GXSSG | GXS | 10, 11 |
| MARIBANKSG | MariBank | 9 |
| ANEXTSG | ANEXT | 11 |

`ALLIANCESG` preserves the historical A3Pay `ABMB` mapping, but no verified Singapore receiving-account format was established. It is unavailable for saving/payout, remains identifiable in saved accounts, and must never borrow the Malaysian Alliance rule. Confirm the bank identity, receiving country and account format with A3Pay before enabling it.

### PayNow mobile destinations

[DBS's PayNow FAQ](https://www.dbs.com.sg/personal/deposits/cas-paynow-faq.page) confirms both local and foreign mobile numbers may be registered. Do not restrict every PayNow recipient to an eight-digit Singapore number. This application's digits-only mobile route accepts 7–15 digits with a non-zero first digit, following its existing E.164 shape guard without the `+`; overseas numbers must include their country code. This is a format check, not verification of PayNow registration. NRIC/FIN, UEN and VPA routes are not supported by this numeric field.

## Enforcement

The canonical registry supplies lengths, optional mobile pattern and guidance to the bank picker. The shared server validator runs when saving, before withdrawal debit, and before held-payout approval. Invalid saved accounts remain visible but unavailable. Missing rules fail closed in the picker and payout routing; sandbox dummy accounts have their own 12-digit test format. No account numbers are converted to numeric values or rewritten to another country.
