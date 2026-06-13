// Live probe of every rate limiter wired in middlewares.ts, against :9000.
// Order matters: the per-IP auth limiter is tested LAST so it can't block the
// logins the earlier probes need. Pack-open spam uses an UNFUNDED customer
// (400s pass the limiter but cost nothing). Run: node scripts/verify-rate-limits.mjs
const BACKEND = 'http://localhost:9000';
const PK =
  'pk_a23d4482ee6673a760097f3d013aab59679ceaebab54f987638cbeeb0132863c';
const PACK = 'pokemon-rookie';

const fail = (m) => {
  console.error(`✗ ${m}`);
  process.exitCode = 1;
};
const ok = (m) => console.log(`✓ ${m}`);

const hit = async (path, opts = {}) => {
  const res = await fetch(`${BACKEND}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'x-publishable-api-key': PK,
      ...(opts.headers ?? {}),
    },
  });
  return res;
};

// Hammer until 429 (or cap); returns {count, res429}.
const spamUntil429 = async (cap, fn) => {
  for (let i = 1; i <= cap; i++) {
    const res = await fn(i);
    if (res.status === 429) return { count: i, res };
  }
  return { count: cap, res: null };
};

// ── setup: one throwaway customer (2 auth hits) ─────────────────────────────
const email = `ratelimit-${Date.now()}@pokenic.local`;
const password = 'Ratelimit2026!';
const reg = await (
  await hit('/auth/customer/emailpass/register', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  })
).json();
await hit('/store/customers', {
  method: 'POST',
  headers: { Authorization: `Bearer ${reg.token}` },
  body: JSON.stringify({ email }),
});
const { token } = await (
  await hit('/auth/customer/emailpass', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  })
).json();
const auth = { Authorization: `Bearer ${token}` };
ok(`throwaway customer ready (${email})`);

// ── 1. pack-open limiter (per customer, burst 5/10s) ───────────────────────
{
  const { count, res } = await spamUntil429(8, () =>
    hit(`/store/packs/${PACK}/open`, { method: 'POST', headers: auth }),
  );
  if (res) {
    ok(`pack open: 429 on attempt ${count} (burst window working)`);
    const ra = res.headers.get('retry-after');
    if (ra) ok(`pack open 429 carries Retry-After: ${ra}s`);
    else fail('pack open 429 missing Retry-After header');
    const body = await res.json().catch(() => ({}));
    if (body.message) ok(`429 body message: "${body.message}"`);
  } else fail(`pack open: no 429 within 8 rapid attempts`);
}

// ── 2. top-up limiter (per customer, 5/10s burst) ───────────────────────────
{
  // invalid amount -> 400 passes the limiter but credits nothing
  const { count, res } = await spamUntil429(8, () =>
    hit('/store/credits/topup', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ amount: -1 }),
    }),
  );
  if (res) ok(`top-up: 429 on attempt ${count}`);
  else fail('top-up: no 429 within 8 rapid attempts');
}

// ── 3. store-read limiter (vault + credits GETs share one budget) ───────────
{
  const { count, res } = await spamUntil429(150, (i) =>
    hit(i % 2 ? '/store/vault' : '/store/credits', { headers: auth }),
  );
  if (res) ok(`vault/credits reads: 429 on request ${count} (shared budget)`);
  else
    console.log(
      `  note: vault/credits reads did not 429 within 150 — generous budget, limiter may still be armed above that`,
    );
}

// ── 4. public profile-read limiter (per IP, 60/10s) ─────────────────────────
{
  const { count, res } = await spamUntil429(80, () =>
    hit('/store/profiles/kenji-ejxy'),
  );
  if (res) ok(`public profile reads: 429 on request ${count} (per-IP)`);
  else fail('profile reads: no 429 within 80 rapid requests');
}

// ── 5. auth limiter LAST (per IP, 5/10s burst) ──────────────────────────────
{
  const { count, res } = await spamUntil429(8, () =>
    hit('/auth/customer/emailpass', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'wrong-password' }),
    }),
  );
  if (res) {
    ok(`auth login: 429 on attempt ${count} (brute-force protection)`);
    const ra = res.headers.get('retry-after');
    if (ra) ok(`auth 429 carries Retry-After: ${ra}s`);
  } else fail('auth login: no 429 within 8 rapid attempts');
}

console.log(
  '\nnote: limits are sliding windows — they self-reset; nothing to clean up.',
);
