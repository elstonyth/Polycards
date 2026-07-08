// Localize the Medusa store from the default EUR/USD/Europe/Medusa-Store seed to
// MYR / Malaysia / Pokenic. Idempotent — re-running converges. Numeric price
// VALUES are preserved (8.45 stays 8.45), only the currency code is relabelled,
// so the storefront (which already renders "RM") looks identical while the admin
// now shows MYR. The custom credit economy (Card.market_value / Pack / ledger in
// sen) is NOT touched — this only relabels the Medusa product/region/store layer.
// Run: node scripts/localize-myr.mjs
const BASE = process.env.MEDUSA_URL || 'http://localhost:9000';
// Credentials come from the environment — never hardcode a secret in source.
// ADMIN_PASSWORD is required; ADMIN_EMAIL defaults to the standing dev admin id.
const ADMIN = {
  email: process.env.ADMIN_EMAIL || 'admin@pokenic.app',
  password: process.env.ADMIN_PASSWORD,
};

async function main() {
  if (!ADMIN.password) {
    throw new Error(
      'Set ADMIN_PASSWORD before running, e.g.  ADMIN_PASSWORD=… node scripts/localize-myr.mjs',
    );
  }
  const authRes = await fetch(`${BASE}/auth/user/emailpass`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ADMIN),
  });
  if (!authRes.ok) {
    throw new Error(
      `admin auth failed: ${authRes.status} ${await authRes.text()}`,
    );
  }
  const { token } = await authRes.json();
  if (!token) throw new Error('admin auth returned no token');
  const H = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  const api = async (path, opts = {}) => {
    const r = await fetch(`${BASE}${path}`, {
      ...opts,
      headers: { ...H, ...(opts.headers || {}) },
    });
    const text = await r.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    if (!r.ok) {
      throw new Error(
        `${opts.method || 'GET'} ${path} → ${r.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`,
      );
    }
    return body;
  };

  // --- store ---
  const { stores } = await api('/admin/stores?limit=1');
  const store = stores[0];
  console.log(
    'store:',
    store.id,
    `"${store.name}"`,
    store.supported_currencies
      .map((c) => c.currency_code + (c.is_default ? '*' : ''))
      .join(','),
  );

  // 1) Add MYR as default, KEEPING eur/usd for now so re-pricing below never
  //    transiently leaves a variant with no store-supported currency.
  await api(`/admin/stores/${store.id}`, {
    method: 'POST',
    body: JSON.stringify({
      supported_currencies: [
        { currency_code: 'myr', is_default: true },
        { currency_code: 'eur' },
        { currency_code: 'usd' },
      ],
    }),
  });
  console.log('✓ MYR added as default currency');

  // 2) Re-price every product variant in MYR using its existing amount (prefer
  //    usd, else eur, else the first price). Replaces the variant price list.
  // Page through ALL products (offset-based) so a catalog >200 is fully re-priced.
  const products = [];
  for (let offset = 0; ; offset += 200) {
    const { products: page, count } = await api(
      `/admin/products?limit=200&offset=${offset}&fields=id,title,variants.id,variants.prices.amount,variants.prices.currency_code`,
    );
    products.push(...page);
    if (page.length === 0 || products.length >= count) break;
  }
  let repriced = 0;
  for (const p of products) {
    const variants = (p.variants || []).map((v) => {
      const prices = v.prices || [];
      const pick =
        prices.find((pr) => pr.currency_code === 'usd') ||
        prices.find((pr) => pr.currency_code === 'eur') ||
        prices[0];
      return {
        id: v.id,
        prices: [{ currency_code: 'myr', amount: pick ? pick.amount : 0 }],
      };
    });
    if (variants.length) {
      await api(`/admin/products/${p.id}`, {
        method: 'POST',
        body: JSON.stringify({ variants }),
      });
      repriced++;
    }
  }
  console.log(
    `✓ re-priced ${repriced}/${products.length} products to MYR (values preserved)`,
  );

  // 3) Malaysia region (create only if no MYR region exists).
  const { regions } = await api(
    '/admin/regions?limit=20&fields=id,name,currency_code',
  );
  let myRegion = regions.find((r) => r.currency_code === 'myr');
  if (!myRegion) {
    const created = await api('/admin/regions', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Malaysia',
        currency_code: 'myr',
        countries: ['my'],
        payment_providers: ['pp_system_default'],
      }),
    });
    myRegion = created.region;
    console.log('✓ created Malaysia region', myRegion.id);
  } else {
    console.log('Malaysia region already exists', myRegion.id);
  }

  // 4) Delete every non-MYR region (Europe, United States). Resilient: an FK
  //    from an existing order would otherwise abort the whole run, so each
  //    delete is caught — a region that can't be removed cleanly is left in
  //    place (the storefront default is already MYR either way).
  for (const r of regions.filter((r) => r.currency_code !== 'myr')) {
    try {
      await api(`/admin/regions/${r.id}`, { method: 'DELETE' });
      console.log(`✓ deleted region "${r.name}" (${r.currency_code})`);
    } catch (e) {
      console.warn(
        `! kept region "${r.name}" (${r.currency_code}) — delete failed: ${e.message}`,
      );
    }
  }

  // 5) Store → MYR only + rename to Pokenic. Safe now: no region/price uses eur/usd.
  await api(`/admin/stores/${store.id}`, {
    method: 'POST',
    body: JSON.stringify({
      name: 'Pokenic',
      supported_currencies: [{ currency_code: 'myr', is_default: true }],
    }),
  });
  console.log('✓ store renamed "Pokenic", currencies = [myr]');

  // 6) Malaysia tax region + remove the stock EU/US tax regions.
  const { tax_regions } = await api('/admin/tax-regions?limit=100');
  if (!tax_regions.some((t) => t.country_code === 'my')) {
    await api('/admin/tax-regions', {
      method: 'POST',
      body: JSON.stringify({ country_code: 'my', provider_id: 'tp_system' }),
    });
    console.log('✓ created Malaysia tax region');
  } else {
    console.log('Malaysia tax region already exists');
  }
  for (const t of tax_regions.filter(
    (t) => (t.country_code || '').toLowerCase() !== 'my',
  )) {
    try {
      await api(`/admin/tax-regions/${t.id}`, { method: 'DELETE' });
      console.log(`✓ deleted tax region "${t.country_code}"`);
    } catch (e) {
      console.warn(
        `! kept tax region "${t.country_code}" — delete failed: ${e.message}`,
      );
    }
  }

  // 7) Rename the default "European Warehouse" stock location → "Malaysia
  //    Warehouse". This is Medusa's stock-seed name and is what surfaces in
  //    admin Settings → Locations & Shipping and the marketplace "Default
  //    location" card (no storefront code renders it). Prod has a single
  //    location, so renaming anything not already "Malaysia Warehouse" is safe.
  const { stock_locations } = await api(
    '/admin/stock-locations?limit=100&fields=id,name',
  );
  for (const loc of (stock_locations || []).filter(
    (l) => l.name !== 'Malaysia Warehouse',
  )) {
    try {
      await api(`/admin/stock-locations/${loc.id}`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Malaysia Warehouse' }),
      });
      console.log(
        `✓ renamed stock location "${loc.name}" → "Malaysia Warehouse"`,
      );
    } catch (e) {
      console.warn(
        `! could not rename stock location "${loc.name}": ${e.message}`,
      );
    }
  }

  // 8) House seller (Mercur) currency → myr. The House seller was created before
  //    PR #54 with the Mercur default 'usd', and the seed only sets the currency
  //    on create — so an existing seller row keeps 'usd' forever without this.
  try {
    const { sellers } = await api(
      '/admin/sellers?limit=100&fields=id,name,handle,currency_code',
    );
    for (const s of (sellers || []).filter(
      (s) => (s.currency_code || '').toLowerCase() !== 'myr',
    )) {
      await api(`/admin/sellers/${s.id}`, {
        method: 'POST',
        body: JSON.stringify({ currency_code: 'myr' }),
      });
      console.log(`✓ seller "${s.name}" currency → myr`);
    }
  } catch (e) {
    console.warn(`! could not update seller currency: ${e.message}`);
  }

  console.log(
    '\nDONE — refresh the admin (Settings → Marketplace / Regions / Tax Regions / Locations).',
  );
}

main().catch((e) => {
  console.error('FAILED:', e && e.stack ? e.stack : e);
  process.exit(1);
});
