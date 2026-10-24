// Fixture backend for the Lucky Draw visual QA (scripts/qa-lucky-draw.mjs).
// DEMO DATA ONLY. A node http server that answers exactly the store routes the
// vault, /lucky-draw and /task pages read, in the shapes of
// backend/packages/api/src/api/store/lucky-draw/view.ts and the task hub
// route; anything else is a logged 404. Auth is ignored (any cookie works).
//
// The timed prize draws `drawIn` seconds after the last reset. Its result is
// built at request time from the live entries (your own included) with the
// real fair-draw maths — HMAC-SHA256(seed hex, prize id) mod total tickets —
// so "How to check" on the result sheet holds for the demo numbers too.
//
// Usage: node scripts/qa-lucky-draw-mock.mjs   (127.0.0.1 only)
//   QA_MOCK_PORT=9199              port (default 9199)
//   QA_DRAW_IN=90                  timed prize draws this many s after start
//   QA_SLAB_IMAGE=<png path>       served at /media/slab.png as the card prize
//   QA_STOREFRONT_ORIGINS=<list>   comma-separated origins allowed by CORS
//                                  (default http://localhost:4100,http://127.0.0.1:4100)
//   POST /__mock/reset?drawIn=60   fresh state, timed prize draws in 60 s
// The storefront under test must be built against it:
//   NEXT_PUBLIC_MEDUSA_BACKEND_URL=http://localhost:9199
//   NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY=pk_mock_preview   (any value; ignored)
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const PORT = Number(process.env.QA_MOCK_PORT ?? 9199);
const SLAB_FILE = process.env.QA_SLAB_IMAGE ?? null;
// Bound to 127.0.0.1 below; `localhost` still reaches it, and the image
// allow-list of a storefront built against localhost keeps matching.
const ORIGIN = `http://localhost:${PORT}`;
// Only the storefront under test may make credentialed browser calls; any
// other origin gets no CORS headers (never reflect the request's Origin).
const ALLOWED_ORIGINS = new Set(
  (
    process.env.QA_STOREFRONT_ORIGINS ??
    'http://localhost:4100,http://127.0.0.1:4100'
  )
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
);
const SLAB_URL = SLAB_FILE
  ? `${ORIGIN}/media/slab.png`
  : '/images/app/polycards-slab-back.webp';
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
// Relative to mock start, so the demo event never ends under the QA run.
const EVENT_END = new Date(Date.now() + 30 * DAY).toISOString();

const person = (who, face) => ({
  who,
  face_seed: face,
  avatar_url: null,
  frame_url: null,
});
const ME = person('Collector4821', 7);
const PEOPLE = {
  ash: person('AshKetchumMY', 3),
  mimo: person('Mimo', 11),
  ddc: person('DDC', 14),
  long: person('PikachuCollectorFromPenang', 21),
  kl: person('KLSlabHunter', 5),
  rin: person('Rin', 9),
  zed: person('ZedTheRipper', 17),
  anon: person('Anonymous', null),
};

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
/** The winning ticket, exactly as ResultDetail's "How to check" describes. */
const winningTicket = (seed, prizeId, total) =>
  Number(
    BigInt('0x' + createHmac('sha256', seed).update(prizeId).digest('hex')) %
      BigInt(total),
  );
const newSeed = () => randomBytes(32).toString('hex');

let state;
function reset(drawInSec = 90) {
  const now = Date.now();
  const prize = (p) => ({ ...p, seed: newSeed() });
  state = {
    balance: 1250,
    history: [
      // Oldest first; the route reverses it.
      { delta: 1200, reason: 'task_claim', created_at: iso(now - 5 * DAY) },
      { delta: 50, reason: 'task_claim', created_at: iso(now - 2 * DAY) },
    ],
    event: {
      id: 'ldev_demo_nov',
      name: 'November 2026',
      starts_at: iso(now - DAY),
      ends_at: EVENT_END,
    },
    // Entries in draw order (the order they first came in).
    prizes: [
      prize({
        id: 'ldp_demo_umbreon',
        kind: 'card',
        title: 'Umbreon ex SAR · PSA 10',
        image: SLAB_URL,
        value_myr: 4200,
        draw_at: iso(now + drawInSec * 1000),
        entries: [
          [PEOPLE.ash, 420],
          [PEOPLE.mimo, 180],
          [PEOPLE.long, 95],
          [PEOPLE.ddc, 60],
          [PEOPLE.kl, 35],
          [PEOPLE.anon, 12],
          [PEOPLE.rin, 8],
          [PEOPLE.zed, 3],
        ],
      }),
      prize({
        id: 'ldp_demo_credit500',
        kind: 'credit',
        title: 'RM 500 bonus credit',
        image: null,
        value_myr: 500,
        draw_at: EVENT_END,
        entries: [
          [PEOPLE.kl, 64],
          [PEOPLE.rin, 22],
        ],
      }),
    ],
    // Last month's drawn prize, so the Results tab has history.
    past: (() => {
      const id = 'ldp_demo_oct_charizard';
      const entries = [
        [PEOPLE.ddc, 300],
        [ME, 140],
        [PEOPLE.ash, 90],
        [PEOPLE.mimo, 20],
      ];
      return {
        id,
        title: 'Charizard ex SIR · PSA 10',
        image: '/images/app/polycards-slab-back.webp',
        value_myr: 2800,
        draw_at: iso(now - 24 * DAY),
        seed: newSeed(),
        entries,
      };
    })(),
  };
}
const iso = (ms) => new Date(ms).toISOString();

const total = (p) => p.entries.reduce((n, [, t]) => n + t, 0);
const mine = (p) =>
  p.entries.filter(([who]) => who === ME).reduce((n, [, t]) => n + t, 0);
const drawn = (p) => Date.now() >= Date.parse(p.draw_at);

/** One entrant per person, tickets summed, kept in first-entry order. */
function merged(p) {
  const by = new Map();
  for (const [who, t] of p.entries) by.set(who, (by.get(who) ?? 0) + t);
  return [...by].map(([who, tickets]) => ({ person: who, tickets }));
}

/** The frozen result — null until the prize's draw time has passed. */
function resultOf(p) {
  if (!drawn(p) || p.entries.length === 0) return null;
  const entries = merged(p);
  const sum = total(p);
  const ticket = winningTicket(p.seed, p.id, sum);
  let next = 0;
  const winner = entries.find((e) => {
    next += e.tickets;
    return ticket < next;
  });
  return {
    view: {
      prize_id: p.id,
      title: p.title,
      image: p.image,
      value_myr: p.value_myr,
      drawn_at: p.draw_at,
      winner: winner.person,
      winner_tickets: winner.tickets,
      total_tickets: sum,
      entrant_count: entries.length,
      seed: p.seed,
      seed_hash: sha256(p.seed),
    },
    entries,
    ticket,
  };
}

function prizeView(p) {
  const entries = merged(p);
  return {
    id: p.id,
    kind: p.kind,
    title: p.title,
    image: p.image,
    value_myr: p.value_myr,
    draw_at: p.draw_at,
    // The commitment only: the seed itself rides on `result`, after the draw.
    seed_hash: sha256(p.seed),
    total_tickets: total(p),
    entrant_count: entries.length,
    my_tickets: mine(p),
    top: [...entries].sort((a, b) => b.tickets - a.tickets).slice(0, 10),
    result: resultOf(p)?.view ?? null,
  };
}

const allDrawable = () => [...state.prizes, state.past];

function tasks() {
  const task = (id, kind, title, requirement, reward, progress, extra) => ({
    id,
    kind,
    title,
    requirement,
    reward,
    progress,
    claimed: false,
    tickets: 0,
    ...extra,
  });
  return {
    week_start: iso(Date.now() - 2 * DAY),
    day_key: iso(Date.now()).slice(0, 10),
    checkins_this_week: 3,
    vip_level: 4,
    checked_in_today: true,
    pending_spins: [],
    tasks: [
      task(
        'td_rip3',
        'daily',
        'Rip 3 packs today',
        { type: 'rip_count' },
        { type: 'credit', amount_myr: 2 },
        { current: 3, target: 3, completed: true },
        { tickets: 5 },
      ),
      task(
        'td_topup50',
        'daily',
        'Top up RM 50 today',
        { type: 'topup_myr' },
        { type: 'credit', amount_myr: 5 },
        { current: 20, target: 50, completed: false },
        { tickets: 120 },
      ),
      task(
        'td_checkin',
        'daily',
        'Check in today',
        { type: 'checkin_days', days: 1 },
        { type: 'credit', amount_myr: 1 },
        { current: 1, target: 1, completed: true },
        { claimed: true, tickets: 1 },
      ),
      task(
        'tw_topup500',
        'weekly',
        'Top up RM 500 this week',
        { type: 'topup_myr' },
        { type: 'credit', amount_myr: 25 },
        { current: 180, target: 500, completed: false },
        { tickets: 50 },
      ),
      task(
        'ta_rip100',
        'achievement',
        'Rip 100 packs',
        { type: 'rip_count' },
        { type: 'credit', amount_myr: 50 },
        { current: 64, target: 100, completed: false },
        { tickets: 999 },
      ),
    ],
  };
}

const CUSTOMER = {
  id: 'cus_demo_lucky',
  email: 'demo@example.test',
  first_name: 'Demo',
  last_name: 'Player',
  phone: '+60123456789',
  addresses: [],
  metadata: { handle: 'collector4821' },
};

function route(method, path, query, body) {
  if (method === 'POST' && path === '/__mock/reset') {
    reset(Number(query.get('drawIn') ?? 90));
    return [200, { ok: true, draw_at: state.prizes[0].draw_at }];
  }
  if (method === 'GET') {
    switch (path) {
      case '/store/customers/me':
        return [200, { customer: CUSTOMER }];
      case '/store/announcements':
        return [200, { announcements: [] }];
      case '/store/pack-gifts':
        return [200, { gifts: [] }];
      case '/store/vault':
        return [200, { items: [] }];
      case '/store/credits/balance':
        return [200, { balance: 128.4 }];
      case '/store/tasks':
        return [200, tasks()];
      case '/store/lucky-draw':
        return [
          200,
          {
            balance: state.balance,
            event: state.event,
            prizes: state.prizes.map(prizeView),
          },
        ];
      case '/store/lucky-draw/balance':
        return [200, { balance: state.balance }];
      case '/store/lucky-draw/me':
        return [
          200,
          {
            balance: state.balance,
            history: [...state.history].reverse(),
            entries: allDrawable()
              .filter((p) => mine(p) > 0)
              .map((p) => {
                const r = resultOf(p);
                return {
                  prize_id: p.id,
                  title: p.title,
                  image: p.image,
                  my_tickets: mine(p),
                  draw_at: p.draw_at,
                  status: !r ? 'open' : r.view.winner === ME ? 'won' : 'lost',
                };
              })
              .sort((a, b) => (a.draw_at < b.draw_at ? 1 : -1)),
          },
        ];
      case '/store/lucky-draw/results':
        return [
          200,
          {
            results: allDrawable()
              .map((p) => resultOf(p)?.view)
              .filter(Boolean)
              .sort((a, b) => (a.drawn_at < b.drawn_at ? 1 : -1)),
            next_before: null,
          },
        ];
    }
    const res = path.match(/^\/store\/lucky-draw\/results\/([^/]+)$/);
    if (res) {
      const p = allDrawable().find((x) => x.id === res[1]);
      const r = p && resultOf(p);
      if (!r) return [404, { type: 'not_found', message: 'No result yet' }];
      return [
        200,
        { result: r.view, entries: r.entries, ticket_index: r.ticket },
      ];
    }
  }
  const enter = path.match(/^\/store\/lucky-draw\/prizes\/([^/]+)\/enter$/);
  if (method === 'POST' && enter) {
    const p = state.prizes.find((x) => x.id === enter[1]);
    if (!p) return [200, { entered: false, reason: 'not_found' }];
    const t = body?.tickets;
    if (!Number.isInteger(t) || t < 1) {
      return [400, { type: 'invalid_data', message: 'Bad ticket amount' }];
    }
    if (drawn(p)) return [200, { entered: false, reason: 'closed' }];
    if (t > state.balance) {
      return [200, { entered: false, reason: 'not_enough_tickets' }];
    }
    state.balance -= t;
    p.entries.push([ME, t]);
    state.history.push({
      delta: -t,
      reason: 'entry',
      created_at: iso(Date.now()),
    });
    return [
      200,
      {
        entered: true,
        entryId: `lde_demo_${p.entries.length}`,
        balance: state.balance,
        myTickets: mine(p),
      },
    ];
  }
  return [404, { type: 'not_found', message: `mock: no ${method} ${path}` }];
}

reset(Number(process.env.QA_DRAW_IN ?? 90));

createServer((req, res) => {
  const url = new URL(req.url, ORIGIN);
  const origin = req.headers.origin;
  const cors =
    origin && ALLOWED_ORIGINS.has(origin)
      ? {
          'access-control-allow-origin': origin,
          'access-control-allow-credentials': 'true',
          'access-control-allow-headers': '*',
          'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
          vary: 'Origin',
        }
      : { vary: 'Origin' };
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors).end();
    return;
  }
  if (req.method === 'GET' && url.pathname === '/media/slab.png' && SLAB_FILE) {
    res.writeHead(200, { ...cors, 'content-type': 'image/png' });
    res.end(readFileSync(SLAB_FILE));
    return;
  }
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = null;
    }
    const [status, json] = route(
      req.method,
      url.pathname,
      url.searchParams,
      body,
    );
    console.log(`${status} ${req.method} ${url.pathname}${url.search}`);
    res.writeHead(status, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify(json));
  });
}).listen(PORT, '127.0.0.1', () => console.log(`lucky-draw mock on ${ORIGIN}`));
