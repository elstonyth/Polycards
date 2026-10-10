import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { computePackListBody } from '../../../admin/packs/route';

// Categories the public catalogue never lists (store/packs/route.ts).
const UNLISTED = new Set(['reward_box', 'free_welcome']);

// GET /reports/store/packs: every pack with the numbers the admin pack list
// shows (computePackListBody), cut down to what the Store desk may see: price,
// buyback, status, the sold-out badge, the published odds and their EV/RTP,
// and the real EV/RTP of odds set 1 (what the DEFAULT group plays). Never the
// other odds sets, per-card weights, target RTP or costs.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const { packs } = await computePackListBody(req);
  res.json({
    currency: 'MYR',
    packs: packs.map((p) => ({
      slug: p.slug,
      title: p.title,
      category: p.category,
      status: p.status,
      listed_publicly: p.status === 'active' && !UNLISTED.has(p.category),
      sold_out_badge: !p.in_stock,
      price: Number(p.price),
      buyback_percent: p.buyback_percent,
      pool: p.group,
      published_odds: p.published_odds?.tiers ?? null,
      published_ev: p.pub_ev,
      published_rtp_pct: p.pub_rtp,
      ev: p.ev.s1,
      rtp_pct: p.rtp.s1,
    })),
    note: "ev and rtp_pct are odds set 1 (what the DEFAULT group plays) at today's card prices; published_ev and published_rtp_pct use the published tier odds. sold_out_badge = sold out: the pack stays listed but paid opens are refused; vault gifts and free rips already given still open. pool is the card mix (RAW, GRADED or MIX).",
  });
}
