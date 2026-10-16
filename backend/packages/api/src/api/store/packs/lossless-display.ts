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

/** Test seam: module state outlives a test's fixtures (see clearPackListCache). */
export function clearLosslessDisplayMemo(): void {
  memo = null;
}

/**
 * The memoized windows, or [] when the read fails — a badge that under-promises
 * (shows the pack's own rate) beats a 500 on the catalog. A failure is not
 * memoized, so the next request retries.
 */
export async function losslessWindowsForDisplay(
  req: MedusaRequest,
): Promise<LosslessWindow[]> {
  const now = Date.now();
  if (memo && memo.expires > now) return memo.windows;
  try {
    const windows = await req.scope
      .resolve<PacksModuleService>(PACKS_MODULE)
      .losslessWindows(now);
    memo = { expires: now + MEMO_TTL_MS, windows };
    return windows;
  } catch (err) {
    req.scope
      .resolve(ContainerRegistrationKeys.LOGGER)
      .warn(
        `[store-packs] Lossless windows read failed; serving badges at the pack rate: ${err instanceof Error ? err.message : String(err)}`,
      );
    return [];
  }
}
