// Open one pack for the dev customer straight through the store API, to move
// the playthrough counter without driving the reel UI. Local/sandbox tooling.
//
//   node scripts/qa-open-pack-api.mjs raw-demo-pack
//
// Reads CUST_EMAIL / CUST_PW from scripts/.dev-logins and the publishable key
// from .env.local; prints nothing secret.

import fs from 'node:fs';
import path from 'node:path';

const BACKEND = process.env.BACKEND_BASE ?? 'http://127.0.0.1:9000';
const slug = process.argv[2] ?? 'raw-demo-pack';

const kv = (file) =>
  Object.fromEntries(
    fs
      .readFileSync(path.resolve(file), 'utf8')
      .split(/\r?\n/)
      .map((l) => l.match(/^([A-Z_]+)=(.*)$/))
      .filter(Boolean)
      .map((m) => [m[1], m[2].trim()]),
  );
const logins = kv('scripts/.dev-logins');
const local = kv('.env.local');
const pk = local.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY;
if (!pk) throw new Error('publishable key not found in .env.local');

const json = async (url, init = {}) => {
  const r = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'x-publishable-api-key': pk,
      ...(init.headers ?? {}),
    },
  });
  const text = await r.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: r.status, body };
};

const login = await json(`${BACKEND}/auth/customer/emailpass`, {
  method: 'POST',
  body: JSON.stringify({
    email: logins.CUST_EMAIL ?? 'test@polycards.app',
    password: logins.CUST_PW,
  }),
});
if (login.status !== 200) throw new Error(`login ${login.status}`);
const auth = { Authorization: `Bearer ${login.body.token}` };

const before = await json(`${BACKEND}/store/credits`, { headers: auth });
console.log('before:', JSON.stringify(before.body.wallet));

const open = await json(
  `${BACKEND}/store/packs/${encodeURIComponent(slug)}/open`,
  {
    method: 'POST',
    headers: auth,
    body: '{}',
  },
);
console.log(
  'open:',
  open.status,
  open.status === 200
    ? `card=${open.body.card?.name ?? open.body.card?.title ?? '?'} price=${open.body.price} balance=${open.body.balance} buyback=${JSON.stringify(open.body.buyback)}`
    : JSON.stringify(open.body).slice(0, 300),
);

const after = await json(`${BACKEND}/store/credits`, { headers: auth });
console.log('after:', JSON.stringify(after.body.wallet));

// Optional: sell the newest vault item back so the balance is withdrawable
// (playthrough is already satisfied by the open above).
if (process.env.SELL_BACK === '1') {
  const vault = await json(`${BACKEND}/store/vault`, { headers: auth });
  const items = vault.body.items ?? [];
  const item = items.find((i) => i.pull_id || i.pullId || i.id) ?? items[0];
  const pullId = item?.pull_id ?? item?.pullId ?? item?.id;
  if (!pullId) throw new Error('no vault item to sell back');
  const sell = await json(`${BACKEND}/store/vault/${pullId}/buyback`, {
    method: 'POST',
    headers: auth,
    body: '{}',
  });
  console.log('buyback:', sell.status, JSON.stringify(sell.body).slice(0, 200));
  const final = await json(`${BACKEND}/store/credits`, { headers: auth });
  console.log('final:', JSON.stringify(final.body.wallet));
}
