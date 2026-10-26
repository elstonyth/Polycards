#!/usr/bin/env node
// End-to-end check of the GlobePay365 (USDT) rail against the LOCAL stack and
// the local mock (scripts/a3pay-mock.mjs --tenant gp365). Drives the real HTTP
// routes as an admin and a customer, lets the mock send signed callbacks, and
// checks the database rows, not just status codes. The SGD twin is
// scripts/a3pay-e2e.mjs.
//
// Prereqs: backend started with the mock env (%TEMP%/gp365-mock.env +
// GATEWAY_ENABLED / GATEWAY_WITHDRAWALS_ENABLED / PAYMENT_CALLBACK_BASE /
// PAYOUT_DESTINATION_COOLDOWN_HOURS=0), the mock running, pokenic-postgres
// up, and scripts/.dev-logins (gitignored) holding ADMIN_PW / CUST_PW.
//
//   node scripts/gp365-e2e.mjs            deposit legs (default)
//   node scripts/gp365-e2e.mjs payouts    payout legs — run separately, for a
//                                         customer whose deposits are played through
//
// E2E_API / E2E_MOCK / E2E_LOGINS override the backend, the mock and the
// logins file (a worktree backend on :9100 reads the main checkout's logins).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const API = process.env.E2E_API ?? 'http://127.0.0.1:9000';
const MOCK = process.env.E2E_MOCK ?? 'http://127.0.0.1:4456';
const LOGINS =
  process.env.E2E_LOGINS ?? new URL('./.dev-logins', import.meta.url);

const logins = Object.fromEntries(
  readFileSync(LOGINS, 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const ADMIN_EMAIL = logins.ADMIN_EMAIL || 'admin@pokenic.app';
const CUST_EMAIL = logins.CUST_EMAIL || 'test@pokenic.app';

const PG_USER = execFileSync('docker', [
  'exec',
  'pokenic-postgres',
  'printenv',
  'POSTGRES_USER',
])
  .toString()
  .trim();
function sql(query) {
  return execFileSync('docker', [
    'exec',
    'pokenic-postgres',
    'psql',
    '-U',
    PG_USER,
    '-d',
    'medusa',
    '-At',
    '-F',
    '|',
    '-c',
    query,
  ])
    .toString()
    .trim();
}
const PK = sql(
  "select token from api_key where type='publishable' and revoked_at is null limit 1",
);

// Tether's own contracts: real, checksummed addresses on each chain.
const TRON = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const TRON_TYPO = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u';

let failures = 0;
const results = [];
function check(name, cond, detail = '') {
  results.push(
    `${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`,
  );
  if (!cond) failures += 1;
  console.log(results.at(-1));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, path, { token, body, admin } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(admin ? {} : { 'x-publishable-api-key': PK }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

async function login(actor, email, password) {
  const r = await call('POST', `/auth/${actor}/emailpass`, {
    body: { email, password },
    admin: actor === 'user',
  });
  if (!r.json.token) throw new Error(`${actor} login failed (${r.status})`);
  return r.json.token;
}

const mock = async (path, body) =>
  (
    await fetch(`${MOCK}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  ).json();
const mockState = async () => (await fetch(`${MOCK}/__control/state`)).json();

const row = (table, mtid) =>
  sql(
    `select status, currency, gateway_amount, fx_mid, fx_markup, ${table === 'gateway_deposit' ? 'amount_requested' : 'amount'}, amount_settled, net_amount, gateway from ${table} where merchant_transaction_id='${mtid}'`,
  ).split('|');

const balance = async (token) =>
  (await call('GET', '/store/credits/balance', { token })).json;

// USDT priced at 4.20 RM (manual) with the operator's 0.5% fee each way: a
// top-up credits 4.20 x 99.5% = 4.179, a withdrawal debits 4.20 x 100.5% =
// 4.221. A percent, never an absolute RM markup.
async function setFx(admin, percent, reason) {
  return call('POST', '/admin/payments/fx', {
    token: admin,
    admin: true,
    body: {
      currency: 'USDT',
      fee_enabled: true,
      deposit_fee_percent: percent,
      payout_fee_percent: percent,
      manual_override: true,
      manual_rate: 4.2,
      reason,
    },
  });
}

async function main() {
  const admin = await login('user', ADMIN_EMAIL, logins.ADMIN_PW);
  const cust = await login('customer', CUST_EMAIL, logins.CUST_PW);

  // ---- 1. Admin sets the USDT rate + fee (audited)
  const fx = await setFx(admin, 0.5, 'gp365 e2e: base rate');
  check(
    'admin sets USDT market rate 4.20 + fee 0.5% each way (4.179 / 4.221)',
    fx.status === 200 &&
      fx.json.quote?.depositRate === 4.179 &&
      fx.json.quote?.payoutRate === 4.221,
    JSON.stringify({
      status: fx.status,
      quote: fx.json.quote,
      msg: fx.json.message,
    }),
  );
  const audit = sql(
    "select count(*) from admin_action_audit where entity_type='fx' and entity_id='USDT_MYR' and reason like 'gp365 e2e%'",
  );
  check('USDT fee edit is audited', Number(audit) >= 1, `${audit} audit rows`);
  const sgdUntouched = await call('GET', '/admin/payments/fx?currency=SGD', {
    token: admin,
    admin: true,
  });
  check(
    'the SGD card is a separate row',
    sgdUntouched.status === 200 && sgdUntouched.json.currency === 'SGD',
    `${sgdUntouched.status} ${sgdUntouched.json.currency}`,
  );

  // ---- 2. Storefront config advertises the USDT rail with today's rates
  const cfg = await call('GET', '/store/payments/config');
  const rail = cfg.json.regional?.find((r) => r.currency === 'USDT');
  check(
    'payments config lists the open USDT rail',
    rail?.deposits_enabled === true && rail?.rate?.deposit === 4.179,
    JSON.stringify(rail),
  );

  if (process.argv[2] === 'payouts') await payoutLegs(admin, cust);
  else await depositLegs(admin, cust);
  console.log(`\n${results.length - failures}/${results.length} checks passed`);
  process.exit(failures ? 1 : 0);
}

async function depositLegs(admin, cust) {
  // ---- 3. USDT deposit (TRC20), no payer name, settled by callback
  const before = (await balance(cust)).balance;
  const d1 = await call('POST', '/store/credits/deposit', {
    token: cust,
    body: { amount: 100, currency: 'USDT', payment_method_code: 'UTRC' },
  });
  check(
    'USDT deposit starts with no payer name: 100 USDT quotes RM 417.90',
    d1.status === 200 && d1.json.amount === 417.9,
    JSON.stringify({
      status: d1.status,
      amount: d1.json.amount,
      msg: d1.json.message,
    }),
  );
  check(
    'cashier URL is the GlobePay365 page (https)',
    /^https:\/\/cashier\.gp365\.mock\/cashier\/D/.test(d1.json.url ?? ''),
    d1.json.url,
  );
  const m1 = d1.json.merchantTransactionId;
  const r1 = row('gateway_deposit', m1);
  check(
    'deposit row: gp365, USDT, 100, mid 4.2, locked markup 0.021, RM 417.90',
    r1[0] === 'pending' &&
      r1[1] === 'USDT' &&
      Number(r1[2]) === 100 &&
      Number(r1[3]) === 4.2 &&
      Number(r1[4]) === 0.021 &&
      Number(r1[5]) === 417.9 &&
      r1[8] === 'gp365',
    r1.join('|'),
  );
  const payin = (await mockState()).payins.find((p) => p.mtid === m1);
  check(
    'GlobePay365 got UTRC and no FromCustomerAccountHolderName',
    payin?.method === 'UTRC' && payin?.payer === undefined,
    JSON.stringify({ method: payin?.method, payer: payin?.payer }),
  );

  await mock(`/__control/payin/${m1}`, { status: 6 });
  await sleep(500);
  const r1b = row('gateway_deposit', m1);
  const afterD1 = (await balance(cust)).balance;
  check(
    'callback settles at RM 417.90',
    r1b[0] === 'settled' && Number(r1b[6]) === 417.9,
    r1b.join('|'),
  );
  check(
    'ledger credited exactly RM 417.90',
    Math.round((afterD1 - before) * 100) === 41790,
    `${before} -> ${afterD1}`,
  );
  check(
    'net stored in RM at the locked rate (98.50 USDT x 4.179)',
    Number(r1b[7]) === 411.63,
    r1b[7],
  );
  await mock(`/__control/payin/${m1}`, { status: 6 });
  await sleep(500);
  check(
    'replayed callback credits nothing more',
    (await balance(cust)).balance === afterD1,
  );

  // ---- 4. Callback lost: the sweep requeries and credits
  const d2 = await call('POST', '/store/credits/deposit', {
    token: cust,
    body: { amount: 20, currency: 'USDT', payment_method_code: 'UTRC' },
  });
  check(
    '20 USDT (TRC20) quotes RM 83.58',
    d2.json.amount === 83.58,
    `${d2.status} ${d2.json.amount} ${d2.json.message ?? ''}`,
  );
  const m2 = d2.json.merchantTransactionId;
  const beforeSweep = (await balance(cust)).balance;
  await mock(`/__control/silent/payin/${m2}`, { status: 6 });
  let swept = false;
  for (let i = 0; i < 40 && !swept; i += 1) {
    await sleep(5000);
    swept = row('gateway_deposit', m2)[0] === 'settled';
  }
  const r2 = row('gateway_deposit', m2);
  check(
    'sweep settles a callback-less USDT deposit via GetPayinDetail',
    swept && Number(r2[6]) === 83.58,
    r2.join('|'),
  );
  check(
    'sweep credit is RM, not USDT',
    Math.round(((await balance(cust)).balance - beforeSweep) * 100) === 8358,
  );

  // ---- 5. Guards
  const sgdMethod = await call('POST', '/store/credits/deposit', {
    token: cust,
    body: { amount: 100, currency: 'USDT', payment_method_code: 'BQR' },
  });
  check(
    "A3Pay's PayNow channel refused on the USDT rail",
    sgdMethod.status === 400,
    sgdMethod.json.message,
  );
  const tooSmall = await call('POST', '/store/credits/deposit', {
    token: cust,
    body: { amount: 5, currency: 'USDT', payment_method_code: 'UTRC' },
  });
  check(
    'USDT band floor enforced (5 < 10)',
    tooSmall.status === 400 && /USDT 10/.test(tooSmall.json.message ?? ''),
    tooSmall.json.message,
  );
  const forged = await fetch(`${API}/hooks/gp365/deposit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      Data: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      Signature: 'x',
    }),
  });
  check(
    'unsigned GlobePay365 callback rejected',
    forged.status === 400,
    `${forged.status}`,
  );
}

async function payoutLegs(admin, cust) {
  const customerId = sql(
    `select id from customer where email='${CUST_EMAIL}' and deleted_at is null limit 1`,
  );

  // ---- 6. Save a TRC20 wallet (no holder name), refuse a typo'd one
  const typo = await call('POST', '/store/credits/withdraw/accounts', {
    token: cust,
    body: { bank_code: 'USDTTRC20', account_number: TRON_TYPO },
  });
  check(
    'a TRC20 address with a broken checksum is refused',
    typo.status === 400 && /TRC20/.test(typo.json.message ?? ''),
    `${typo.status} ${typo.json.message}`,
  );
  const acct = await call('POST', '/store/credits/withdraw/accounts', {
    token: cust,
    body: { bank_code: 'USDTTRC20', account_number: TRON },
  });
  const w = acct.json.accounts?.find((a) => a.bankCode === 'USDTTRC20');
  check(
    'TRC20 wallet saved with no holder name, payable, tagged USDT',
    w?.supported === true &&
      w?.currency === 'USDT' &&
      w?.accountNumber === TRON &&
      w?.accountHolderName === w?.bankName,
    JSON.stringify({ status: acct.status, w, msg: acct.json.message }),
  );
  const banks = await call('GET', '/store/credits/withdraw/banks', {
    token: cust,
  });
  check(
    'picker lists the wallets with their chain and currency',
    banks.json.banks?.some(
      (b) =>
        b.bankCode === 'USDTTRC20' &&
        b.wallet === 'tron' &&
        b.currency === 'USDT',
    ) &&
      banks.json.banks?.some(
        (b) => b.bankCode === 'USDTERC20' && b.wallet === 'evm',
      ),
    JSON.stringify(banks.json.banks?.filter((b) => b.currency === 'USDT')),
  );

  // ---- 7. Withdraw RM 300 -> 71.07 USDT (300 / 4.221, floored)
  const wBefore = (await balance(cust)).balance;
  const w1 = await call('POST', '/store/credits/withdraw', {
    token: cust,
    body: { amount: 300, account_id: w?.id },
  });
  check(
    'withdraw RM 300 to the wallet -> USDT 71.07 (at 4.221)',
    w1.status === 200 &&
      w1.json.currency === 'USDT' &&
      w1.json.payAmount === 71.07,
    JSON.stringify({ status: w1.status, ...w1.json }),
  );
  const mw1 = w1.json.merchantTransactionId;
  if (mw1) {
    await sleep(1500);
    const p = (await mockState()).payouts.find((x) => x.mtid === mw1);
    check(
      'GlobePay365 got USDTTRC, the address, and MCustId as the holder',
      p?.amount === 71.07 &&
        p?.bank === 'USDTTRC' &&
        p?.account === TRON &&
        p?.holder === customerId,
      JSON.stringify({
        amount: p?.amount,
        bank: p?.bank,
        account: p?.account,
        holder: p?.holder,
        customerId,
      }),
    );
    check(
      'payout verification answered "success"',
      p?.verify?.text === 'success',
      JSON.stringify(p?.verify),
    );
    await mock(`/__control/payout/${mw1}`, { status: 4 });
    await sleep(500);
    const rw = row('gateway_withdrawal', mw1);
    check(
      'payout settled; row in RM with the USDT lock',
      rw[0] === 'settled' &&
        rw[1] === 'USDT' &&
        Number(rw[2]) === 71.07 &&
        Number(rw[5]) === 300 &&
        rw[8] === 'gp365',
      rw.join('|'),
    );
    check(
      'ledger debited RM 300',
      Math.round((wBefore - (await balance(cust)).balance) * 100) === 30000,
    );
  }

  // ---- 8. Failed payout refunds
  const w2Before = (await balance(cust)).balance;
  const w2 = await call('POST', '/store/credits/withdraw', {
    token: cust,
    body: { amount: 280, account_id: w?.id },
  });
  if (w2.json.merchantTransactionId) {
    await sleep(1500);
    await mock(`/__control/payout/${w2.json.merchantTransactionId}`, {
      status: 5,
    });
    await sleep(800);
    const rw2 = row('gateway_withdrawal', w2.json.merchantTransactionId);
    check(
      'status 5 fails and refunds the payout',
      rw2[0] === 'failed' && (await balance(cust)).balance === w2Before,
      `${rw2[0]} ${w2Before}`,
    );
  } else check('second withdrawal started', false, JSON.stringify(w2.json));

  // ---- 9. Below the floor is refused before any debit. Which floor bites
  // first (the RM band or the USDT one) depends on the limits configured.
  const tinyBefore = (await balance(cust)).balance;
  const tiny = await call('POST', '/store/credits/withdraw', {
    token: cust,
    body: { amount: 250, account_id: w?.id },
  });
  check(
    'RM 250 (= USDT 59.22, under the 60 floor) refused before any debit',
    tiny.status === 400 &&
      /USDT 60|RM 253/.test(tiny.json.message ?? '') &&
      (await balance(cust)).balance === tinyBefore,
    tiny.json.message,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
