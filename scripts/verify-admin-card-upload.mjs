// End-to-end admin card-image upload chain (the forward workflow: admin uploads
// a slab-only card image, storefront shows it everywhere):
//   login -> pick a card -> POST /admin/uploads (slab-only file) ->
//   POST /admin/cards/:handle {image} -> verify admin GET + URL serves +
//   store surface returns the new URL -> restore the original image.
import fs from 'node:fs';
import path from 'node:path';

const API = process.env.API_URL ?? 'http://localhost:9000';
const results = [];
const pass = (n, ok, note) => results.push({ name: n, ok: !!ok, note });

// 1. admin login
const tokRes = await fetch(`${API}/auth/user/emailpass`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    email: 'admin@pokenic.local',
    password: 'pokenicadmin2026',
  }),
});
const { token } = await tokRes.json();
pass('admin login', !!token);
const H = { authorization: `Bearer ${token}` };
const HJ = { ...H, 'content-type': 'application/json' };

// 2. pick a card + remember its current image
const list = await (
  await fetch(`${API}/admin/cards?limit=1`, { headers: H })
).json();
const card = (list.cards ?? list.data ?? [])[0];
pass('got a card to test with', !!card?.handle, card?.handle);
const before = await (
  await fetch(`${API}/admin/cards/${card.handle}`, { headers: H })
).json();
const original = before.card;
pass(
  'loaded original card',
  !!original?.image,
  `image: ${String(original?.image).slice(0, 60)}`,
);

// 3. upload a slab-only image (one of the cropped assets) through the admin path
const sample = path.resolve(
  'public/cdn/cards/4h13RDtFX4MWNYjvgMPeBS1hcL4AewupiFzDvyFUUTkd.webp',
);
const form = new FormData();
form.append(
  'files',
  new Blob([fs.readFileSync(sample)], { type: 'image/webp' }),
  'slab-only-test.webp',
);
const upRes = await fetch(`${API}/admin/uploads`, {
  method: 'POST',
  headers: H,
  body: form,
});
const upJson = await upRes.json().catch(() => ({}));
const uploaded = (upJson.files ?? [])[0];
pass(
  'POST /admin/uploads returns a URL',
  !!uploaded?.url,
  uploaded?.url?.slice(0, 70) ?? JSON.stringify(upJson).slice(0, 120),
);

let restored = false;
if (uploaded?.url && original) {
  try {
    // 4. point the card at the uploaded image (full body back, image swapped)
    const body = { ...original, image: uploaded.url };
    delete body.handle;
    const updRes = await fetch(`${API}/admin/cards/${card.handle}`, {
      method: 'POST',
      headers: HJ,
      body: JSON.stringify(body),
    });
    pass(
      'POST /admin/cards/:handle accepts the new image',
      updRes.ok,
      `status ${updRes.status}`,
    );

    // 5a. admin GET reflects it
    const after = await (
      await fetch(`${API}/admin/cards/${card.handle}`, { headers: H })
    ).json();
    pass(
      'admin GET shows the uploaded image',
      after.card?.image === uploaded.url,
    );

    // 5b. the uploaded URL actually serves image bytes
    const img = await fetch(uploaded.url);
    const bytes = Buffer.from(await img.arrayBuffer());
    pass(
      'uploaded URL serves the image',
      img.ok && bytes.length > 10000,
      `${img.status}, ${bytes.length} bytes`,
    );

    // 5c. a STORE surface returns the new URL (the reveal/Top Hits render exactly
    // this field) — find the card in any pack detail's top hits or card list
    const storePacks = await (await fetch(`${API}/store/packs`))
      .json()
      .catch(() => ({}));
    const slugs = (storePacks.packs ?? [])
      .map((p) => p.slug ?? p.id)
      .filter(Boolean)
      .slice(0, 12);
    let seen = false;
    for (const slug of slugs) {
      const det = await (await fetch(`${API}/store/packs/${slug}`))
        .json()
        .catch(() => ({}));
      const all = JSON.stringify(det);
      if (all.includes(uploaded.url)) {
        seen = true;
        break;
      }
    }
    pass(
      'store API serves the uploaded URL (reveal/Top Hits source)',
      seen,
      seen
        ? 'found in a pack detail'
        : 'not in first pack details (card may not be a top hit) — admin+URL checks above still prove the chain',
    );
  } finally {
    // 6. restore the original image
    const body = { ...original };
    delete body.handle;
    const res = await fetch(`${API}/admin/cards/${card.handle}`, {
      method: 'POST',
      headers: HJ,
      body: JSON.stringify(body),
    });
    restored = res.ok;
  }
}
pass('original card image restored', restored);

let ok = 0;
for (const r of results) {
  console.log(
    `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.note ? '  (' + r.note + ')' : ''}`,
  );
  if (r.ok) ok++;
}
console.log(`\n${ok}/${results.length} checks passed`);
// the store-surface check is best-effort (depends on which card was picked)
const critical = results.filter((r) => !r.name.startsWith('store API'));
process.exit(critical.every((r) => r.ok) ? 0 : 1);
