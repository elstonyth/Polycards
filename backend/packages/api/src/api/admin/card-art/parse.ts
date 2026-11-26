// Clean card art: one image per card printing, keyed by its code. One Piece
// codes are a booster/starter/extra/premium code (OP05-119, ST01-001,
// EB02-006, PRB01-001) or a promo (P-101), plus `_pN` for the Nth alternate
// art (OP05-119_p3) — the naming Bandai's card list and our files use.

const CODE = /^((?:OP|ST|EB|PRB)\d{2}-\d{3}|P-\d{3})(?:_p(\d{1,2}))?$/i;

/** The canonical code (upper-case base, lower-case `_p`), or null. */
export function normalizeCardArtCode(raw: string): string | null {
  const m = CODE.exec(raw);
  if (!m) return null;
  return m[1].toUpperCase() + (m[2] ? `_p${Number(m[2])}` : '');
}

export const CARD_ART_BATCH_MAX = 200;

export type CardArtItem = { code: string; image_url: string };

export function parseCardArtBody(
  b: Record<string, unknown>,
): { ok: true; value: CardArtItem[] } | { ok: false; message: string } {
  const items = Array.isArray(b.items) ? b.items : null;
  if (!items || items.length === 0 || items.length > CARD_ART_BATCH_MAX) {
    return {
      ok: false,
      message: `'items' must hold 1 to ${CARD_ART_BATCH_MAX} entries.`,
    };
  }
  const byCode = new Map<string, CardArtItem>();
  for (const it of items as Record<string, unknown>[]) {
    const code =
      typeof it?.code === 'string'
        ? normalizeCardArtCode(it.code.trim())
        : null;
    if (!code)
      return { ok: false, message: `Not a card code: ${String(it?.code)}` };
    const image_url =
      typeof it.image_url === 'string' ? it.image_url.trim() : '';
    // our own uploaded media only: http(s) or root-relative, never data:/javascript:/"//host"
    if (!/^(https?:\/\/|\/(?![/\\]))/.test(image_url)) {
      return {
        ok: false,
        message: `'image_url' for ${code} must be an uploaded image URL.`,
      };
    }
    byCode.set(code, { code, image_url });
  }
  return { ok: true, value: [...byCode.values()] };
}
