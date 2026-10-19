#!/usr/bin/env node
// End-to-end check of the A3Pay (SGD) rail against the LOCAL stack and the
// local A3Pay mock (scripts/a3pay-mock.mjs). Drives the real HTTP routes as
// an admin and a customer, lets the mock send signed callbacks, and checks
// the database rows, not just status codes.
//
// Prereqs: backend :9000 started with the mock env (%TEMP%/a3pay-mock.env +
// GATEWAY_ENABLED / GATEWAY_WITHDRAWALS_ENABLED / PAYMENT_CALLBACK_BASE /
// PAYOUT_DESTINATION_COOLDOWN_HOURS=0), mock on :4455, pokenic-postgres up,
// and scripts/.dev-logins (gitignored) holding ADMIN_PW / CUST_PW.
//
//   node scripts/a3pay-e2e.mjs            deposit legs (default)
//   node scripts/a3pay-e2e.mjs payouts    payout legs — run separately, for a
//                                         customer whose deposits are played through
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const API = 'http://127.0.0.1:9000';
const MOCK = 'http://127.0.0.1:4455';

const logins = Object.fromEntries(
  readFileSync(new URL('./.dev-logins', import.meta.url), 'utf8')
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

const row = (table, mtid) =>
  sql(
    `select status, currency, gateway_amount, fx_mid, fx_markup, ${table === 'gateway_deposit' ? 'amount_requested' : 'amount'}, amount_settled, net_amount from ${table} where merchant_transaction_id='${mtid}'`,
  ).split('|');

const balance = async (token) =>
  (await call('GET', '/store/credits/balance', { token })).json;

// `percent` is the fee each way: 0.3125% of 3.20 is RM 0.01.
async function setFx(admin, percent, reason) {
  return call('POST', '/admin/payments/fx', {
    token: admin,
    admin: true,
    body: {
      fee_enabled: true,
      deposit_fee_percent: percent,
      payout_fee_percent: percent,
      manual_override: true,
      manual_rate: 3.2,
      reason,
    },
  });
}

async function main() {
  const admin = await login('user', ADMIN_EMAIL, logins.ADMIN_PW);
  const cust = await login('customer', CUST_EMAIL, logins.CUST_PW);

  // ---- 1. Admin sets the SGD rate + fee (audited)
  const fx = await setFx(admin, 0.3125, 'a3pay e2e: base rate');
  check(
    'admin sets SGD market rate 3.20 + fee 0.3125% each way',
    fx.status === 200 &&
      fx.json.quote?.depositRate === 3.19 &&
      fx.json.quote?.payoutRate === 3.21,
    JSON.stringify(fx.json.quote),
  );
  const audit = sql(
    "select count(*) from admin_action_audit where entity_type='fx' and entity_id='SGD_MYR' and reason like 'a3pay e2e%'",
  );
  check('fee edit is audited', Number(audit) >= 1, `${audit} audit rows`);
  const bad = await call('POST', '/admin/payments/fx', {
    token: admin,
    admin: true,
    body: {
      fee_enabled: true,
      deposit_fee_percent: 50,
      payout_fee_percent: 50,
      manual_override: true,
      manual_rate: 3.2,
      reason: 'too big',
    },
  });
  check('absurd fee refused', bad.status === 400, `${bad.status}`);

  // ---- 2. Storefront config advertises the SGD rail with today's rates
  const cfg = await call('GET', '/store/payments/config');
  const rail = cfg.json.regional?.find((r) => r.currency === 'SGD');
  check(
    'payments config lists the open SGD rail',
    rail?.deposits_enabled === true && rail?.rate?.deposit === 3.19,
    JSON.stringify(rail?.rate),
  );

  // `payouts` skips the deposit legs: every deposit re-locks its amount
  // behind playthrough, so a payout run needs a customer whose deposits are
  // already played through.
  if (process.argv[2] === 'payouts') await payoutLegs(admin, cust);
  else await depositLegs(admin, cust);
  await earningsLeg(admin);
  console.log(`\n${results.length - failures}/${results.length} checks passed`);
  process.exit(failures ? 1 : 0);
}

async function depositLegs(admin, cust) {
  // ---- 3. SGD deposit, settled by callback, at the LOCKED rate
  const before = (await balance(cust)).balance;
  const d1 = await call('POST', '/store/credits/deposit', {
    token: cust,
    body: {
      amount: 100,
      currency: 'SGD',
      payment_method_code: 'OB',
      payer_name: 'TAN AH KOW',
    },
  });
  check(
    'SGD deposit starts: S$100 quotes RM 319.00',
    // The currency lives on the row (checked below), not in this response.
    d1.status === 200 && d1.json.amount === 319,
    JSON.stringify({
      status: d1.status,
      amount: d1.json.amount,
      url: d1.json.url,
      msg: d1.json.message,
    }),
  );
  check(
    'cashier URL is the gateway page (https)',
    /^https:\/\/cashier\.a3pay\.mock\/cashier\/D/.test(d1.json.url ?? ''),
  );
  const moved = await call('POST', '/store/credits/deposit', {
    token: cust,
    body: {
      amount: 100,
      currency: 'SGD',
      payment_method_code: 'OB',
      payer_name: 'TAN AH KOW',
      quoted_rate: 3.05, // not today's 3.19
    },
  });
  check(
    'a deposit quoted at a rate that has since moved is refused',
    moved.status === 400 &&
      /exchange rate just changed/i.test(moved.json.message ?? ''),
    `${moved.status} ${moved.json.message}`,
  );
  const m1 = d1.json.merchantTransactionId;
  const r1 = row('gateway_deposit', m1);
  check(
    'deposit row locks currency, S$ amount, mid, markup and RM credit',
    r1[0] === 'pending' &&
      r1[1] === 'SGD' &&
      Number(r1[2]) === 100 &&
      Number(r1[3]) === 3.2 &&
      Number(r1[4]) === 0.01 &&
      Number(r1[5]) === 319,
    r1.join('|'),
  );

  // Markup changes BEFORE the customer pays — the lock must hold.
  await setFx(admin, 3.125, 'a3pay e2e: fee raised mid-flight');
  await mock(`/__control/payin/${m1}`, { status: 6 });
  await sleep(500);
  const r1b = row('gateway_deposit', m1);
  const afterD1 = (await balance(cust)).balance;
  check(
    'callback settles at the quoted RM 319.00 despite the markup change',
    r1b[0] === 'settled' && Number(r1b[6]) === 319,
    r1b.join('|'),
  );
  check(
    'ledger credited exactly RM 319.00',
    Math.round((afterD1 - before) * 100) === 31900,
    `${before} -> ${afterD1}`,
  );
  check(
    'net amount stored in RM at the locked rate (S$98.50 x 3.19)',
    Number(r1b[7]) === 314.21,
    r1b[7],
  );
  // A replayed callback must not credit twice.
  await mock(`/__control/payin/${m1}`, { status: 6 });
  await sleep(500);
  check(
    'replayed callback credits nothing more',
    (await balance(cust)).balance === afterD1,
  );

  // ---- 4. New quote uses the new markup (3.20 - 0.10)
  const d2 = await call('POST', '/store/credits/deposit', {
    token: cust,
    body: {
      amount: 50,
      currency: 'SGD',
      payment_method_code: 'BQR',
      payer_name: 'TAN AH KOW',
    },
  });
  check(
    'next deposit quotes at the NEW rate: S$50 -> RM 155.00',
    d2.json.amount === 155,
    `${d2.json.amount}`,
  );
  const m2 = d2.json.merchantTransactionId;

  // ---- 5. Payin status 4 (Verify Fail) is not final
  await mock(`/__control/payin/${m2}`, { status: 4 });
  await sleep(400);
  check(
    'status 4 leaves the deposit pending',
    row('gateway_deposit', m2)[0] === 'pending',
  );

  // ---- 6. Callback lost: the sweep requeries and credits (converted)
  const beforeSweep = (await balance(cust)).balance;
  await mock(`/__control/silent/payin/${m2}`, { status: 6 });
  let swept = false;
  for (let i = 0; i < 40 && !swept; i += 1) {
    await sleep(5000);
    swept = row('gateway_deposit', m2)[0] === 'settled';
  }
  const r2 = row('gateway_deposit', m2);
  check(
    'sweep settles a callback-less deposit via GetPayinDetail',
    swept && Number(r2[6]) === 155,
    r2.join('|'),
  );
  check(
    'sweep credit is RM, not S$',
    Math.round(((await balance(cust)).balance - beforeSweep) * 100) === 15500,
  );

  // ---- 7. Failed payin closes without credit
  const d3 = await call('POST', '/store/credits/deposit', {
    token: cust,
    body: {
      amount: 40, // above the S$30 floor
      currency: 'SGD',
      payment_method_code: 'OB',
      payer_name: 'TAN AH KOW',
    },
  });
  await mock(`/__control/payin/${d3.json.merchantTransactionId}`, {
    status: 7,
  });
  await sleep(400);
  check(
    'status 7 fails the deposit',
    row('gateway_deposit', d3.json.merchantTransactionId)[0] === 'failed',
  );

  // ---- 8. No name sent: the backend uses a saved Singapore account's
  // holder, and with none saved refuses (the real name alone is never sent —
  // a nickname failed A3Pay's name check on 2026-10-13). The sheet reads the
  // same rule from GET /store/credits/deposit/payer.
  const payerLookup = await call(
    'GET',
    '/store/credits/deposit/payer?currency=SGD',
    { token: cust },
  );
  const savedName = payerLookup.json?.saved_name ?? null;
  check(
    'payer lookup answers for the customer',
    payerLookup.status === 200 && 'saved_name' in (payerLookup.json ?? {}),
    JSON.stringify({ status: payerLookup.status, json: payerLookup.json }),
  );
  const noName = await call('POST', '/store/credits/deposit', {
    token: cust,
    // Its own amount, closed below: an open S$100 here would make the mock
    // nudge the next run's S$100 to S$100.01.
    body: { amount: 77, currency: 'SGD', payment_method_code: 'OB' },
  });
  const noNamePayin = (
    await (await fetch(`${MOCK}/__control/state`)).json()
  ).payins.find((p) => p.mtid === noName.json.merchantTransactionId);
  check(
    savedName
      ? "SGD deposit without a typed name sends the saved account's holder"
      : 'SGD deposit without a typed name and nothing saved is refused',
    savedName
      ? noName.status === 200 && noNamePayin?.payer === savedName
      : noName.status === 400 &&
          /name on the bank account/i.test(noName.json?.message ?? ''),
    JSON.stringify({
      status: noName.status,
      payer: noNamePayin?.payer,
      msg: noName.json.message,
    }),
  );
  if (noName.json.merchantTransactionId)
    await mock(`/__control/payin/${noName.json.merchantTransactionId}`, {
      status: 7,
    });
  // ---- 8b. Guards
  const tooBig = await call('POST', '/store/credits/deposit', {
    token: cust,
    body: {
      amount: 5001,
      currency: 'SGD',
      payment_method_code: 'OB',
      payer_name: 'TAN AH KOW',
    },
  });
  check(
    'SGD band enforced (S$5,001 > S$5,000, #785)',
    tooBig.status === 400 && /5,000/.test(tooBig.json.message ?? ''),
    tooBig.json.message,
  );
  const forged = await fetch(`${API}/hooks/a3pay/deposit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      Data: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      Signature: 'x',
    }),
  });
  check(
    'unsigned callback rejected',
    forged.status === 400,
    `${forged.status}`,
  );
}

async function payoutLegs(admin, cust) {
  // ---- 9. Withdrawal to a Singapore bank
  await setFx(admin, 0.3125, 'a3pay e2e: back to base');
  const acct = await call('POST', '/store/credits/withdraw/accounts', {
    token: cust,
    body: {
      bank_code: 'DBSSSGSG',
      account_number: '1234567890',
      account_holder_name: 'TAN AH KOW',
    },
  });
  const sg = acct.json.accounts?.find((a) => a.bankCode === 'DBSSSGSG');
  check(
    'Singapore account saved, payable, tagged SGD',
    sg?.supported === true && sg?.currency === 'SGD',
    JSON.stringify({ status: acct.status, sg, msg: acct.json.message }),
  );
  const banks = await call('GET', '/store/credits/withdraw/banks', {
    token: cust,
  });
  check(
    'bank picker lists SG banks with currency',
    banks.json.banks?.some(
      (b) => b.bankCode === 'POSBSG' && b.currency === 'SGD',
    ),
  );

  const wBefore = (await balance(cust)).balance;
  const w1 = await call('POST', '/store/credits/withdraw', {
    token: cust,
    body: { amount: 200, account_id: sg?.id },
  });
  check(
    'withdraw RM 200 to DBS -> S$62.30 (at 3.21)',
    w1.status === 200 &&
      w1.json.currency === 'SGD' &&
      w1.json.payAmount === 62.3,
    JSON.stringify({ status: w1.status, ...w1.json }),
  );
  const mw1 = w1.json.merchantTransactionId;
  if (mw1) {
    await sleep(1500); // mock's payout verification
    const state = await (await fetch(`${MOCK}/__control/state`)).json();
    const p = state.payouts.find((x) => x.mtid === mw1);
    check(
      'A3Pay received S$62.30 to bank code SDBS',
      p?.amount === 62.3 && p?.bank === 'SDBS',
      JSON.stringify({ amount: p?.amount, bank: p?.bank }),
    );
    check(
      'payout verification answered "success"',
      p?.verify?.text === 'success',
      JSON.stringify(p?.verify),
    );
    const vo = sql(
      `select verify_outcome from gateway_withdrawal where merchant_transaction_id='${mw1}'`,
    );
    check('verify outcome recorded on the row', / success$/.test(vo), vo);
    await mock(`/__control/payout/${mw1}`, { status: 4 });
    await sleep(500);
    const rw = row('gateway_withdrawal', mw1);
    check(
      'payout settled; row in RM with S$ lock',
      rw[0] === 'settled' &&
        rw[1] === 'SGD' &&
        Number(rw[2]) === 62.3 &&
        Number(rw[5]) === 200 &&
        Number(rw[6]) === 200,
      rw.join('|'),
    );
    check(
      'ledger debited RM 200',
      Math.round((wBefore - (await balance(cust)).balance) * 100) === 20000,
    );
  }

  // ---- 10. Failed payout refunds
  const w2Before = (await balance(cust)).balance;
  const w2 = await call('POST', '/store/credits/withdraw', {
    token: cust,
    body: { amount: 180, account_id: sg?.id },
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

  // ---- 10b. Below A3Pay's S$ floor is refused before any debit
  const tiny = await call('POST', '/store/credits/withdraw', {
    token: cust,
    body: { amount: 90, account_id: sg?.id },
  });
  check(
    'RM 90 (= S$28.03 < S$30 floor) refused before debit',
    tiny.status === 400 && /SGD 30/.test(tiny.json.message ?? ''),
    tiny.json.message,
  );

  // ---- 10c. Held payout (> RM 1,000) approved AFTER a markup change pays
  // the S$ amount locked when the customer asked.
  const w3 = await call('POST', '/store/credits/withdraw', {
    token: cust,
    body: { amount: 1500, account_id: sg?.id },
  });
  check(
    'RM 1,500 payout is held for approval, quoted S$467.28',
    w3.json.status === 'held' && w3.json.payAmount === 467.28,
    JSON.stringify(w3.json),
  );
  const heldId = sql(
    `select id from gateway_withdrawal where merchant_transaction_id='${w3.json.merchantTransactionId}'`,
  );
  // 9.375% of 3.20 is RM 0.30.
  await setFx(admin, 9.375, 'a3pay e2e: fee raised before approval');
  const approve = await call(
    'POST',
    `/admin/payments/withdrawals/${heldId}/approve`,
    { token: admin, admin: true, body: {} },
  );
  await sleep(1500);
  const state3 = await (await fetch(`${MOCK}/__control/state`)).json();
  const p3 = state3.payouts.find(
    (x) => x.mtid === w3.json.merchantTransactionId,
  );
  check(
    "approved held payout pays the LOCKED S$467.28, not today's rate",
    approve.status === 200 &&
      p3?.amount === 467.28 &&
      p3?.verify?.text === 'success',
    JSON.stringify({
      approve: approve.status,
      amount: p3?.amount,
      verify: p3?.verify?.text,
      msg: approve.json.message,
    }),
  );
  if (p3) {
    await mock(`/__control/payout/${p3.mtid}`, { status: 4 });
    await sleep(500);
    const rw3 = row('gateway_withdrawal', p3.mtid);
    check(
      'held payout settles in RM 1,500',
      rw3[0] === 'settled' && Number(rw3[6]) === 1500,
      rw3.join('|'),
    );
  }
  await setFx(admin, 0.3125, 'a3pay e2e: back to base');
}

async function earningsLeg(admin) {
  // ---- 11. Admin earnings figure
  const fx2 = await call('GET', '/admin/payments/fx', {
    token: admin,
    admin: true,
  });
  // The S$ that really moved: the lock scaled by settled / locked RM (a row
  // settled at another sum than quoted is valued at what it paid). Each side
  // rounded on its own, then added — as the admin route does.
  const dbEarn = sql(
    `select round(coalesce((select sum(gateway_amount*coalesce(amount_settled,amount_requested)/amount_requested*fx_mid - coalesce(amount_settled,amount_requested)) from gateway_deposit where currency='SGD' and status='settled'),0), 2) + round(coalesce((select sum(amount - gateway_amount*coalesce(amount_settled,amount)/amount*fx_mid) from gateway_withdrawal where currency='SGD' and status='settled'),0), 2)`,
  );
  check(
    'admin "conversion earned" matches the rows',
    Math.round(fx2.json.earnings?.total_rm * 100) ===
      Math.round(Number(dbEarn) * 100),
    `${fx2.json.earnings?.total_rm} vs ${dbEarn}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
