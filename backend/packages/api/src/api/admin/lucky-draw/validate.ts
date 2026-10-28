import { MedusaError } from '@medusajs/framework/utils';

const invalid = (message: string): never => {
  throw new MedusaError(MedusaError.Types.INVALID_DATA, message);
};

// An unparseable date must never become "no date" — that would publish a window
// or draw time the operator did not mean.
const isoDate = (value: unknown, field: string): Date => {
  const date = typeof value === 'string' ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) {
    return invalid(`${field} must be an ISO date-time string.`);
  }
  return date;
};

const text = (value: unknown, field: string): string =>
  typeof value === 'string' ? value : invalid(`${field} is required.`);

const optText = (value: unknown, field: string): string | null =>
  value == null
    ? null
    : typeof value === 'string'
      ? value
      : invalid(`${field} must be text.`);

const optId = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

/** The most prizes one create request may carry. */
export const MAX_NEW_EVENT_PRIZES = 100;

/** One prize's fields, as POST /admin/lucky-draw/prizes and the `prizes` of a
 *  new event both take them. */
function parsePrizeFields(raw: Record<string, unknown>) {
  if (raw.kind !== 'card' && raw.kind !== 'credit') {
    invalid("kind must be 'card' or 'credit'.");
  }
  if (raw.credit_myr != null && typeof raw.credit_myr !== 'number') {
    invalid('credit_myr must be a number.');
  }
  if (
    raw.sort !== undefined &&
    !(typeof raw.sort === 'number' && Number.isInteger(raw.sort))
  ) {
    invalid('sort must be a whole number.');
  }
  return {
    kind: raw.kind as 'card' | 'credit',
    cardHandle: optText(raw.card_handle, 'card_handle'),
    creditMyr: (raw.credit_myr as number | null | undefined) ?? null,
    title: text(raw.title, 'title'),
    imageUrl: optText(raw.image_url, 'image_url'),
    sort: (raw.sort as number | undefined) ?? 0,
    drawAt:
      raw.draw_at == null || raw.draw_at === ''
        ? null
        : isoDate(raw.draw_at, 'draw_at'),
  };
}

/** Shape checks for POST /admin/lucky-draw/events (create, or edit with `id`).
 *  A create may carry its whole prize pool in `prizes` (an edit may not: its
 *  prizes go through the prize route). Name length, the window rules and what
 *  makes a prize valid are the service's. */
export function parseLuckyDrawEvent(body: unknown): {
  id?: string;
  name: string;
  startsAt: Date;
  endsAt: Date;
  prizes?: ReturnType<typeof parsePrizeFields>[];
} {
  const raw = (body ?? {}) as Record<string, unknown>;
  const id = optId(raw.id);
  let prizes: ReturnType<typeof parsePrizeFields>[] | undefined;
  if (raw.prizes != null) {
    if (id) invalid('An existing event takes no prizes here.');
    if (!Array.isArray(raw.prizes)) invalid('prizes must be a list.');
    const list = raw.prizes as unknown[];
    if (list.length > MAX_NEW_EVENT_PRIZES) {
      invalid(`A new event takes at most ${MAX_NEW_EVENT_PRIZES} prizes.`);
    }
    prizes = list.map((item) =>
      typeof item === 'object' && item !== null
        ? parsePrizeFields(item as Record<string, unknown>)
        : invalid('Each prize must be an object.'),
    );
  }
  return {
    id,
    name: text(raw.name, 'name'),
    startsAt: isoDate(raw.starts_at, 'starts_at'),
    endsAt: isoDate(raw.ends_at, 'ends_at'),
    ...(prizes ? { prizes } : {}),
  };
}

/** Shape checks for POST /admin/lucky-draw/prizes (create, or edit with `id`).
 *  Card existence, amount range and the event rules are the service's. */
export function parseLuckyDrawPrize(body: unknown): {
  id?: string;
  eventId: string;
  kind: 'card' | 'credit';
  cardHandle: string | null;
  creditMyr: number | null;
  title: string;
  imageUrl: string | null;
  sort: number;
  drawAt: Date | null;
} {
  const raw = (body ?? {}) as Record<string, unknown>;
  return {
    id: optId(raw.id),
    eventId: text(raw.event_id, 'event_id'),
    ...parsePrizeFields(raw),
  };
}
