import { toMoney } from './money';

// The display fields shared by the card-detail responses. Card.market_value is
// a numeric column; everything else is a plain string. Kept loose (the Card
// model carries more) so callers pass a Card row directly.
export type CardLike = {
  handle: string;
  name: string;
  set: string;
  grader: string;
  grade: string;
  market_value: unknown;
  image: string;
  slab_image: string | null;
};

// Index a card list by its stable business key (Card.handle === the join key
// used by odds rows and pulls). Replaces `new Map(cards.map(c => [c.handle, c]))`
// repeated across the card routes.
export function cardByHandle<T extends { handle: string }>(
  cards: T[],
): Map<string, T> {
  return new Map(cards.map((c) => [c.handle, c]));
}

// A card is GRADED iff it carries a grader (Card.grader is NOT NULL, so raw
// cards store ''). Trimmed: a whitespace-only grader is a raw card typed
// sloppily, and counting it as graded would flip a pack's composition (§2.4.8).
// Shared so the odds editor and the packs list can never disagree on RAW/GRADED.
export const isGraded = (c: { grader: string }): boolean =>
  c.grader.trim() !== '';

// card_id/rarity are nullable on the row (reward rows have neither); the lookup
// keys defensively and defaults to "Common", so a reward row passed in here is
// harmless — it just never matches a real (pack, card) card lookup.
type OddsRow = {
  pack_id: string;
  card_id: string | null;
  rarity: string | null;
};

// Per-pack rarity lookup: rarity belongs to the (pack, card) link (PackOdds),
// not the card. Replaces the hand-built `rarityByPair` Map + `?? "Common"`
// default duplicated in the vault, recent-pulls, and profile routes. The key
// separator is internal — callers only see the (packId, cardId) lookup.
export function makeRarityOf(
  odds: OddsRow[],
): (packId: string, cardId: string) => string {
  const byPair = new Map(
    odds.map((o) => [`${o.pack_id} ${o.card_id}`, o.rarity]),
  );
  return (packId, cardId) => byPair.get(`${packId} ${cardId}`) ?? 'Common';
}

// The canonical 8-field public card view, with FMV normalized to a JSON number.
// Adopted ONLY by routes whose card object is exactly these fields
// (store/packs/[slug] and store/vault). Routes with a different field set
// (pulls/recent = 5 flat fields; profiles = no rarity) keep their own shape and
// use toMoney + makeRarityOf only.
export function toCardView(card: CardLike, rarity: string) {
  return {
    handle: card.handle,
    name: card.name,
    set: card.set,
    grader: card.grader,
    grade: card.grade,
    rarity,
    market_value: toMoney(card.market_value),
    image: card.image,
    slab_image: card.slab_image ?? null,
  };
}
