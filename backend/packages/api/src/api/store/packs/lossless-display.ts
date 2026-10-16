import type { MedusaRequest } from '@medusajs/framework/http';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../modules/packs';
import type PacksModuleService from '../../../modules/packs/service';
import type { LosslessWindow } from '../../../modules/packs/lossless';

// Lossless windows for the store's pack BADGES only (GET /store/packs and
// /store/packs/:slug) — never for a price. Memoized per process for 10s, so a
// cached catalog hit costs no query on every anonymous home view. The memo
// holds the windows, not a decision: callers still decide at Date.now(), so a
// window's start or end flips on time and only a new create/cancel lags ≤10s.
// The pricing paths (buyback-pull, quoteBuyback, vault, admin pulls) read
// windows live and must never come through here.
const MEMO_TTL_MS = 10_000;
let memo: { expires: number; windows: LosslessWindow[] } | null = null;
// Single flight: concurrent callers past an expiry share ONE read, so a slow or
// exhausted pool parks one query, not one per catalog request.
let inFlight: Promise<LosslessWindow[]> | null = null;

/** Test seam: module state outlives a test's fixtures (see clearPackListCache). */
export function clearLosslessDisplayMemo(): void {
  memo = null;
  inFlight = null;
}

/**
 * The memoized windows. A failed read is memoized too, for one TTL, holding
 * the last good windows or [] — a badge that under-promises (shows the pack's
 * own rate) beats a 500, and retrying per request under pool exhaustion would
 * hold every catalog view behind the acquire timeout. One failure per TTL also
 * means one warning per TTL.
 */
export async function losslessWindowsForDisplay(
  req: MedusaRequest,
): Promise<LosslessWindow[]> {
  if (memo && memo.expires > Date.now()) return memo.windows;
  inFlight ??= refresh(req).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function refresh(req: MedusaRequest): Promise<LosslessWindow[]> {
  let windows: LosslessWindow[];
  try {
    windows = await req.scope
      .resolve<PacksModuleService>(PACKS_MODULE)
      .losslessWindows(Date.now());
  } catch (err) {
    windows = memo?.windows ?? [];
    req.scope
      .resolve(ContainerRegistrationKeys.LOGGER)
      .warn(
        `[store-packs] Lossless windows read failed; serving the last known badges for ${MEMO_TTL_MS / 1000}s: ${err instanceof Error ? err.message : String(err)}`,
      );
  }
  // Expiry from settle time, so a read that waited out a slow pool still
  // earns a full TTL before the next one.
  memo = { expires: Date.now() + MEMO_TTL_MS, windows };
  return windows;
}
