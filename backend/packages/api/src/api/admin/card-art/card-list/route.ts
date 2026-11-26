import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import {
  ContainerRegistrationKeys,
  MedusaError,
} from '@medusajs/framework/utils';
import type { Knex } from 'knex';
import { CARD_LIST_ORIGIN, fetchCardList } from '../card-list';

// POST /admin/card-art/card-list — re-read the One Piece card list from
// Limitless (~150 pages, ~15 s) and store it whole. The Card art page's
// "Missing" list compares it with the uploaded art. A read that finds far
// fewer printings than the stored list (Limitless changed its layout, or a
// page came back empty) is refused and the stored list kept.

const MIN_PRINTINGS = 1000;
const KEEP_SHARE = 0.9; // a refresh may shrink the list by at most 10%

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const db = req.scope.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
  let list;
  try {
    list = await fetchCardList(async (path) => {
      const r = await fetch(CARD_LIST_ORIGIN + path, {
        headers: { 'user-agent': 'Polycards admin card list' },
        signal: AbortSignal.timeout(20_000),
      });
      if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
      return r.text();
    });
  } catch (e) {
    throw new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      `Could not read the card list from Limitless (${(e as Error).message}). The stored list is unchanged.`,
    );
  }
  const { rows } = await db.raw(`select count(*)::int as n from card_list`);
  const stored: number = rows[0].n;
  if (list.length < MIN_PRINTINGS || list.length < stored * KEEP_SHARE) {
    throw new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      `The card list read found only ${list.length} printings (stored: ${stored}). Limitless may have changed its pages; the stored list is unchanged.`,
    );
  }
  await db.transaction(async (trx) => {
    await trx.raw(`delete from card_list`);
    for (let i = 0; i < list.length; i += 500) {
      await trx('card_list').insert(
        list.slice(i, i + 500).map((e) => ({ code: e.code, name: e.name })),
      );
    }
  });
  res.json({ count: list.length, previous: stored });
}
