"use server";

/**
 * Open-pack server action. Called from the client pack detail (the "Open Pack"
 * button). Runs server-side so the customer JWT stays in the httpOnly cookie and
 * the backend call isn't CORS-blocked (AUTH/STORE CORS don't list :4000).
 *
 * The backend derives the customer id from the bearer token alone — this action
 * never sends an id — so a pull can't be forged for another account. The route
 * is POST /store/packs/:slug/open (customer-authenticated).
 */
import { sdk } from "@/lib/medusa";
import { logger } from "@/lib/logger";
import { getAuthToken } from "@/lib/data/customer";
import { isRarity, formatValue } from "@/lib/packs-format";
import type { Rarity } from "@/app/claw/packs-data";

// The won card, shaped for the roulette reveal (same fields as a mock PackCard).
export type WonCard = {
  id: string;
  name: string;
  image: string;
  value: string;
  rarity: Rarity;
};

export type OpenPackResult =
  | { ok: true; card: WonCard }
  | { ok: false; error: string; needsAuth?: boolean };

// Shape of the `card` returned by the open route (normalized server-side).
interface BackendWonCard {
  handle: string;
  name: string;
  image: string;
  market_value: number;
  rarity: string;
}

// Map known backend failures to friendly copy; never surface raw errors.
function friendlyError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (/unauthorized|not authenticated|401/i.test(text))
    return "Please log in to open a pack.";
  if (/not available|not found|404/i.test(text))
    return "This pack isn't available right now.";
  return "Could not open the pack. Please try again.";
}

export async function openPack(slug: string): Promise<OpenPackResult> {
  // Validate at the boundary — a server action is a public endpoint.
  if (typeof slug !== "string" || slug.trim() === "") {
    return { ok: false, error: "Invalid pack." };
  }

  const token = await getAuthToken();
  if (!token) {
    return { ok: false, error: "Please log in to open a pack.", needsAuth: true };
  }

  try {
    const { card } = await sdk.client.fetch<{ card: BackendWonCard }>(
      `/store/packs/${encodeURIComponent(slug)}/open`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: {},
      }
    );

    // The fetch generic is a type assertion, not a runtime guard — validate the
    // shape so a renamed field can't render "$NaN" / an undefined rarity ring.
    if (
      !card ||
      typeof card.handle !== "string" ||
      typeof card.name !== "string" ||
      !isRarity(card.rarity) ||
      !Number.isFinite(card.market_value)
    ) {
      return { ok: false, error: "Got an unexpected response. Please try again." };
    }

    return {
      ok: true,
      card: {
        id: card.handle,
        name: card.name,
        image: card.image,
        value: formatValue(card.market_value),
        rarity: card.rarity,
      },
    };
  } catch (error) {
    logger.error(`[packs] open-pack failed for '${slug}':`, error);
    const text = error instanceof Error ? error.message : String(error);
    const needsAuth = /unauthorized|401/i.test(text);
    return { ok: false, error: friendlyError(error), needsAuth };
  }
}
