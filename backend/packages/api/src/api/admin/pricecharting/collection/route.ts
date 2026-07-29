import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { pcFetch, PC_TOKEN_MISSING } from '../client';
import { normalizeOffer, type PcOffer } from '../collection-offers';

// GET /admin/pricecharting/collection[?cursor=…] — ONE page (~30) of the
// operator's own PriceCharting collection, normalized for bulk import, plus the
// cursor for the next page. Proxied server-side like the other PriceCharting
// routes so the paid API token never reaches the browser.
//
// One page per request, NOT a server-side walk: this account's collection is
// 9,000+ offers (measured 2026-07-30) and still growing, so walking it inside a
// single HTTP call would mean a multi-minute request that reports no progress
// and dies on any timeout. The admin page pages through with live counters and
// can stop early once it has what the operator was looking for.
//
// The route reports what PriceCharting holds — it does NOT price anything. The
// import re-reads each picked product's per-grade FMV through
// /admin/pricecharting/product, so market_value lands on the same basis the
// nightly sync job writes (an offer's `value` is the collection valuation and
// would be overwritten on the first re-sync).

type PcOffersResponse = {
  status: string;
  'error-message'?: string;
  offers?: Array<Record<string, unknown>>;
  cursor?: string;
};

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  // The cursor is the one operator-supplied value that reaches the upstream
  // URL. Real ones are ~40 chars; anything longer is not a cursor.
  const raw = typeof req.query.cursor === 'string' ? req.query.cursor.trim() : '';
  const cursor = raw.length <= 512 ? raw : '';

  // The API token identifies the account, so `seller` is OPTIONAL and normally
  // omitted (verified against the live API 2026-07-30: status=collection with
  // no seller returns this account's collection, while a wrong seller 400s with
  // "user not found"). PRICECHARTING_SELLER_ID stays supported for the case
  // where the token's account is not the collection's owner.
  const params: Record<string, string> = { status: 'collection' };
  const seller = process.env.PRICECHARTING_SELLER_ID?.trim();
  if (seller) params.seller = seller;
  if (cursor) params.cursor = cursor;

  const result = await pcFetch<PcOffersResponse>('/api/offers', params);
  if (result.kind === 'no-token') {
    res.status(503).json({ message: PC_TOKEN_MISSING });
    return;
  }
  if (result.kind === 'error') {
    res.status(502).json({ message: result.message });
    return;
  }

  const page = Array.isArray(result.data.offers) ? result.data.offers : [];
  const offers: PcOffer[] = [];
  for (const raw of page) {
    if (!raw || typeof raw !== 'object') continue;
    const offer = normalizeOffer(raw);
    if (offer) offers.push(offer);
  }

  res.json({
    offers,
    // Empty when the collection is exhausted — that, not an empty page, is how
    // the client knows to stop.
    cursor: typeof result.data.cursor === 'string' ? result.data.cursor : '',
  });
}
