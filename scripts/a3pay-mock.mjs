#!/usr/bin/env node
// Local A3Pay stand-in for end-to-end testing — A3Pay has no sandbox, and its
// production API only answers whitelisted IPs, so this is the only way to run
// the whole SGD loop on a laptop. `--tenant gp365` plays GlobePay365 (USDT),
// the same platform under another name: its own MID, keys, env file and port.
//
// It speaks the real wire format (handbook v3.3.5): every request is an
// AES-256-CBC + RSA-SHA1 envelope, and it REFUSES a request whose signature
// does not verify against the merchant public key — so a green run proves our
// signing, not just our JSON. Callbacks and payout verifications it sends are
// signed with its own ("A3Pay's") key, exactly as production would.
//
//   node scripts/a3pay-mock.mjs [--tenant a3pay|gp365] [--port 4455]
//                               [--backend http://localhost:9000]
//
// Keys: a throwaway merchant pair and a throwaway gateway pair are generated
// on first run and kept in %TEMP%/<tenant>-mock-keys.json. The backend env to
// point at this mock is written to %TEMP%/<tenant>-mock.env (never a real key).
//
// Control endpoints (local only, not part of A3Pay's API):
//   POST /__control/payin/<MTransactionId>   {"status":6}  set status + send the callback
//   POST /__control/payout/<MTransactionId>  {"status":4}  set status + send the callback
//   GET  /__control/state                                  everything the mock holds
//   GET  /cashier/<paymentOrderId>                         a fake cashier page (Pay / Fail)
import { createServer } from 'node:http';
import {
  createCipheriv,
  createDecipheriv,
  createSign,
  createVerify,
  generateKeyPairSync,
  pbkdf2Sync,
  randomBytes,
} from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const TENANTS = {
  a3pay: {
    label: 'A3Pay',
    prefix: 'A3PAY',
    mid: 'SGD00001',
    currency: 'SGD',
    symbol: 'S$',
    port: '4455',
    payerRequired: true,
    banks: [
      'SDBS',
      'POSB',
      'OCBC',
      'UOB',
      'SCBS',
      'CITIS',
      'HSBCS',
      'MBBS',
      'CIMB',
      'RHB',
      'HLB',
      'BOC',
      'ABMB',
      'TBL',
      'GXS',
      'Maribank',
      'PayNow',
      'Wise',
      'LiquidPay',
      'DASH',
    ],
  },
  gp365: {
    label: 'GlobePay365',
    prefix: 'GP365',
    mid: 'GP00001',
    currency: 'USDT',
    symbol: 'USDT ',
    port: '4456',
    payerRequired: false,
    banks: ['USDTTRC', 'USDTERC'],
  },
};
const TENANT_ID = arg('--tenant', 'a3pay');
const TENANT = TENANTS[TENANT_ID];
if (!TENANT) throw new Error('--tenant must be a3pay or gp365');
const PORT = Number(arg('--port', TENANT.port));
const BACKEND = arg('--backend', 'http://127.0.0.1:9000').replace(/\/+$/, '');
const MID = TENANT.mid;
const CURRENCY = TENANT.currency;
const keysPath = join(tmpdir(), `${TENANT_ID}-mock-keys.json`);
const envPath = join(tmpdir(), `${TENANT_ID}-mock.env`);

function pair() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  return {
    publicKey: publicKey.toString('base64'),
    privateKey: privateKey.toString('base64'),
  };
}

const keys = existsSync(keysPath)
  ? JSON.parse(readFileSync(keysPath, 'utf8'))
  : { merchant: pair(), a3pay: pair(), aes: randomBytes(12).toString('hex') };
writeFileSync(keysPath, JSON.stringify(keys));
writeFileSync(
  envPath,
  [
    `${TENANT.prefix}_ENABLED=true`,
    `${TENANT.prefix}_API_BASE=http://localhost:${PORT}`,
    `${TENANT.prefix}_MERCHANT_CODE=${MID}`,
    `${TENANT.prefix}_AES_KEY=${keys.aes}`,
    `${TENANT.prefix}_MERCHANT_PRIVATE_KEY=${keys.merchant.privateKey}`,
    `${TENANT.prefix}_PUBLIC_KEY=${keys.a3pay.publicKey}`,
    `${TENANT.prefix}_CURRENCY=${CURRENCY}`,
    `${TENANT.prefix}_CALLBACK_IPS=127.0.0.1`,
    '',
  ].join('\n'),
);

// --- wire format (mirror of backend/packages/api/src/modules/packs/a3pay.ts)
const aesKey = pbkdf2Sync(keys.aes, keys.aes, 1000, 32, 'sha1');
const encrypt = (text) => {
  const iv = randomBytes(16);
  const c = createCipheriv('aes-256-cbc', aesKey, iv);
  return Buffer.concat([iv, c.update(text, 'utf8'), c.final()]).toString(
    'base64',
  );
};
const decrypt = (b64) => {
  const raw = Buffer.from(b64, 'base64');
  const d = createDecipheriv('aes-256-cbc', aesKey, raw.subarray(0, 16));
  return Buffer.concat([d.update(raw.subarray(16)), d.final()]).toString(
    'utf8',
  );
};
const pem = (k, label) =>
  `-----BEGIN ${label}-----\n${k.match(/.{1,64}/g).join('\n')}\n-----END ${label}-----`;
const sign = (json) =>
  createSign('RSA-SHA1')
    .update(json)
    .sign(pem(keys.a3pay.privateKey, 'PRIVATE KEY'), 'base64');
const verify = (json, sig) => {
  try {
    return createVerify('RSA-SHA1')
      .update(json)
      .verify(pem(keys.merchant.publicKey, 'PUBLIC KEY'), sig, 'base64');
  } catch {
    return false;
  }
};

// --- state
const payins = new Map(); // MTransactionId -> record
const payouts = new Map();
let seq = 0;
const orderId = (prefix) =>
  `${prefix}${new Date().toISOString().slice(0, 10).replace(/-/g, '')}${String(++seq).padStart(8, '0')}`;
const balance = { current: 50000, available: 50000 };

/** Their callbacks go to PAYMENT_CALLBACK_BASE (https, unreachable locally);
 *  replay the PATH against the local backend instead. */
const local = (url) => `${BACKEND}${new URL(url).pathname}`;

async function post(url, body) {
  const res = await fetch(local(url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

function envelope(data, extra = {}) {
  const json = JSON.stringify(data);
  return { ...extra, Data: encrypt(json), Signature: sign(json), Version: 0 };
}

async function payinCallback(p) {
  const r = await post(
    p.callbackUrl,
    envelope(
      {
        MerchantCode: MID,
        CurrencyCode: CURRENCY,
        MerchantTransactionId: p.mtid,
        Status: p.status,
        Amount: p.actual, // what the customer paid, nudge included
        NetAmount: Math.round(p.actual * 0.985 * 100) / 100,
        Remark: p.status === 6 ? 'Success' : 'Fail',
        PaymentMethodCode: p.method,
      },
      {
        TransactionId: p.orderId,
        MerchantTransactionId: p.mtid,
        AdditionalInformationData: encrypt(JSON.stringify({ BankCode: 'DBS' })),
      },
    ),
  );
  p.callbacks.push(r);
  log(`payin callback ${p.mtid} status ${p.status} -> ${r.status} ${r.text}`);
  return r;
}

async function payoutCallback(p) {
  const r = await post(
    p.callbackUrl,
    envelope(
      {
        MerchantCode: MID,
        CurrencyCode: CURRENCY,
        MerchantTransactionId: p.mtid,
        Status: p.status,
        Amount: p.amount,
        NetAmount: Math.round((p.amount + 1.5) * 100) / 100,
        Remark: p.status === 4 ? 'Success' : 'Bank rejected',
        PaymentMethodCode: 'WD',
      },
      { TransactionId: p.orderId, MerchantTransactionId: p.mtid },
    ),
  );
  p.callbacks.push(r);
  log(`payout callback ${p.mtid} status ${p.status} -> ${r.status} ${r.text}`);
  return r;
}

const log = (m) => console.log(`[${TENANT_ID}-mock] ${m}`);
const ok = (data) => ({
  isSuccess: true,
  successCode: 200,
  errorMessage: '',
  errorList: null,
  data,
});
const refuse = (code, description) => ({
  isSuccess: false,
  successCode: 400,
  errorMessage: description,
  errorList: [{ ErrorCode: code, ErrorDescription: description }],
  data: null,
});

/** Open a merchant request: decrypt, VERIFY our signature, parse. */
function open(body) {
  if (body.MerchantCode !== MID && body.merchantCode !== MID)
    throw new Error('bad MerchantCode');
  const json = decrypt(body.Data ?? body.data);
  if (!verify(json, body.Signature ?? body.signature))
    throw new Error('signature verification failed');
  return JSON.parse(json);
}

// Production's requery not-found, measured 2026-10-12: HTTP 400 with no
// error code, message "Not found". `status` is read by the server below.
const notFound = () => ({
  __status: 400,
  isSuccess: false,
  successCode: 0,
  errorCode: null,
  errorMessage: 'Not found',
  errorList: null,
  data: null,
});

const routes = {
  'POST /api/Payin/CreatePayin': (d) => {
    if (payins.has(d.MTransactionId))
      return refuse('PMT10000', 'Duplicate MTransactionId');
    if (TENANT.payerRequired && !d.FromCustomerAccountHolderName)
      return refuse('PMT10020', 'FromCustomerAccountHolderName is required');
    const amount = Number(d.PayinAmount);
    // Uniqueness nudge: a second open payin of the same amount pays a cent more.
    const clash = [...payins.values()].some(
      (p) => p.status !== 6 && p.amount === amount,
    );
    const p = {
      mtid: d.MTransactionId,
      orderId: orderId('D'),
      amount,
      actual: clash ? Math.round((amount + 0.01) * 100) / 100 : amount,
      method: d.PaymentMethodId,
      payer: d.FromCustomerAccountHolderName,
      callbackUrl: d.CallbackURL,
      returnUrl: d.ReturnClientURL,
      status: 1,
      callbacks: [],
    };
    payins.set(p.mtid, p);
    log(
      `CreatePayin ${p.mtid} ${TENANT.symbol}${amount} (${p.method}) payer "${p.payer ?? '-'}"`,
    );
    return ok({
      paymentOrderId: p.orderId,
      // https on a fake host: the storefront refuses a non-https cashier URL
      // (DepositStartSchema). E2E scripts intercept this host and drive
      // /cashier/<id>/pay on the mock instead.
      paymentURL: `https://cashier.${TENANT_ID}.mock/cashier/${p.orderId}`,
      paymentBankCode: null,
      paymentAccountNumber: null,
      paymentAccountHolderName: null,
      paymentReferenceNo: null,
      paymentQRCode: null,
      payinActualAmount: p.actual,
      paymentDeepLink: null,
      bankBranchCode: null,
    });
  },
  'POST /api/Payin/GetPayinDetail': (d) => {
    const p = payins.get(d.MTransactionId);
    if (!p) return notFound();
    return ok({
      paymentOrderId: p.orderId,
      mTransactionId: p.mtid,
      statusId: p.status,
      status:
        { 6: 'Success', 7: 'Fail', 4: 'VerifyFail' }[p.status] ?? 'Processing',
      payinAmount: p.actual,
      payinNetAmount: Math.round(p.actual * 0.985 * 100) / 100,
      paymentMethodId: p.method,
    });
  },
  'POST /api/Payout/SubmitPayout': async (d) => {
    if (payouts.has(d.MTransactionId))
      return refuse('PMT10000', 'Duplicate MTransactionId');
    const amount = Number(d.PayoutAmount);
    const p = {
      mtid: d.MTransactionId,
      orderId: orderId('W'),
      amount,
      bank: d.ToClientBankCode,
      account: d.ToClientAccountNumber,
      holder: d.ToClientAccountHolderName,
      callbackUrl: d.CallBackURL,
      verifyUrl: d.ReturnClientURL,
      status: 1,
      verify: null,
      callbacks: [],
    };
    payouts.set(p.mtid, p);
    log(
      `SubmitPayout ${p.mtid} ${TENANT.symbol}${amount} to ${p.bank} ${p.account} holder "${p.holder}"`,
    );
    // Payout Verification, after the response (as A3Pay does it), so our row
    // already carries its gateway id.
    setTimeout(async () => {
      p.verify = await post(
        p.verifyUrl,
        envelope(
          {
            MerchantTransactionId: p.mtid,
            Amount: p.amount,
            CurrencyCode: CURRENCY,
          },
          {
            MerchantCode: MID,
            AdditionalInformationData: encrypt(
              JSON.stringify({
                DestinationClientBankCode: p.bank,
                DestinationClientAccountNumber: p.account,
                DestinationClientAccountHolderName: p.holder,
              }),
            ),
          },
        ),
      );
      p.status = p.verify.text === 'success' ? 2 : 5;
      log(`payout verify ${p.mtid} -> ${p.verify.status} ${p.verify.text}`);
      if (p.status === 5) await payoutCallback(p);
    }, 300);
    return ok({ paymentOrderId: p.orderId });
  },
  'POST /api/Payout/GetPayoutDetail': (d) => {
    const p = payouts.get(d.MTransactionId);
    if (!p) return notFound();
    return ok({
      paymentOrderId: p.orderId,
      mTransactionId: p.mtid,
      statusId: p.status,
      status: { 4: 'Success', 5: 'Fail' }[p.status] ?? 'Processing',
      payoutAmount: p.amount,
      payoutNetAmount: Math.round((p.amount + 1.5) * 100) / 100,
      paymentMethodId: 'WD',
    });
  },
  'POST /api/Merchant/CheckAccBalance': () =>
    ok({
      mID: MID,
      currCode: CURRENCY,
      currentBalanceAmount: balance.current,
      availableBalanceAmount: balance.available,
    }),
};

const BANKS = TENANT.banks;

function body(req) {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => resolve(s));
  });
}

function send(res, status, payload, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (
      req.method === 'GET' &&
      url.pathname === '/api/Bank/GetSupportedBankList'
    ) {
      return send(
        res,
        200,
        ok(
          BANKS.map((b) => ({
            bankName: b,
            bankNameOrigin: b,
            bankCode: b,
            currCode: CURRENCY,
            mID: MID,
          })),
        ),
      );
    }
    const key = `${req.method} ${url.pathname}`;
    if (routes[key]) {
      const raw = JSON.parse((await body(req)) || '{}');
      let data;
      try {
        data = open(raw);
      } catch (e) {
        log(`REFUSED ${key}: ${e.message}`);
        return send(res, 400, refuse('PMT10001', e.message));
      }
      const out = await routes[key](data);
      const status = out.__status ?? 200;
      delete out.__status;
      return send(res, status, out);
    }
    const control = url.pathname.match(/^\/__control\/(payin|payout)\/(.+)$/);
    if (req.method === 'POST' && control) {
      const [, kind, mtid] = control;
      const { status } = JSON.parse((await body(req)) || '{}');
      const p = (kind === 'payin' ? payins : payouts).get(
        decodeURIComponent(mtid),
      );
      if (!p) return send(res, 404, { error: 'unknown' });
      p.status = Number(status);
      const r =
        kind === 'payin' ? await payinCallback(p) : await payoutCallback(p);
      return send(res, 200, { callback: r });
    }
    if (
      req.method === 'POST' &&
      url.pathname.startsWith('/__control/silent/')
    ) {
      // Change a status WITHOUT a callback — for the "callback lost, the sweep
      // must requery" path.
      const [, , , kind, mtid] = url.pathname.split('/');
      const { status } = JSON.parse((await body(req)) || '{}');
      const p = (kind === 'payin' ? payins : payouts).get(
        decodeURIComponent(mtid),
      );
      if (!p) return send(res, 404, { error: 'unknown' });
      p.status = Number(status);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/__control/state') {
      return send(res, 200, {
        payins: [...payins.values()],
        payouts: [...payouts.values()],
      });
    }
    const cashier = url.pathname.match(/^\/cashier\/([^/]+)(?:\/(pay|fail))?$/);
    if (req.method === 'GET' && cashier) {
      const p = [...payins.values()].find((x) => x.orderId === cashier[1]);
      if (!p) return send(res, 404, 'unknown payin', 'text/plain');
      if (cashier[2]) {
        p.status = cashier[2] === 'pay' ? 6 : 7;
        await payinCallback(p);
        res.writeHead(302, { Location: p.returnUrl || '/' });
        return res.end();
      }
      return send(
        res,
        200,
        `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width"><title>${TENANT.label} mock cashier</title>
<body style="font-family:system-ui;max-width:420px;margin:40px auto;padding:0 16px">
<h2>${TENANT.label} (local mock)</h2><p>Pay <b>${TENANT.symbol}${p.actual.toFixed(2)}</b> by ${p.method}<br>Payer: ${p.payer ?? '-'}<br>Order ${p.orderId}</p>
<p><a id=pay href="/cashier/${p.orderId}/pay">Pay now</a> · <a id=fail href="/cashier/${p.orderId}/fail">Fail payment</a></p></body>`,
        'text/html',
      );
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    log(`ERROR ${e.stack}`);
    // The stack stays in the mock's own log; the caller gets a generic body.
    send(res, 500, { error: 'mock internal error' });
  }
}).listen(PORT, () => {
  log(`listening on http://localhost:${PORT}; callbacks -> ${BACKEND}`);
  log(`backend env written to ${envPath}`);
});
