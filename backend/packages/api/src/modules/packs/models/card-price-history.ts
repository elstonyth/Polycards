import { model } from '@medusajs/framework/utils';

// CardPriceHistory — the FMV audit trail behind the daily PriceCharting sync.
// One row per value change (plus a baseline row the first time a card syncs),
// so the curve of any card's fair-market value is reconstructable for any day.
// `value` is the raw USD decimal, exactly what Card.market_value holds — FX and
// margin are display-time concerns and are never baked into history rows.
const CardPriceHistory = model
  .define('card_price_history', {
    id: model.id().primaryKey(),
    card_id: model.text(),
    value: model.bigNumber(),
  })
  .indexes([{ on: ['card_id'] }]);

export default CardPriceHistory;
