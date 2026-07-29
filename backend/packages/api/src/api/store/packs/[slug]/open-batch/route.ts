import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import {
  ContainerRegistrationKeys,
  MedusaError,
} from '@medusajs/framework/utils';
import { openBatchWorkflow } from '../../../../../workflows/open-batch';
import { PACKS_MODULE } from '../../../../../modules/packs';
import type PacksModuleService from '../../../../../modules/packs/service';
import { toMoney } from '../../../../../modules/packs/money';
import {
  FLAT_PERCENT,
  UNQUOTED_BUYBACK,
  buybackAmount,
  instantDeadlineMs,
} from '../../../../../modules/packs/buyback-rate';
import {
  DEFAULT_MARKET_MULTIPLIER,
  displayMarketPrice,
  resolveFxRateInfo,
} from '../../../../../modules/packs/pricing';

// POST /store/packs/:slug/open-batch — open N packs in one atomic operation:
// rolls N winners, debits count×price from the credit ledger, and records N
// pulls. Returns one buyback quote per roll so the multi-reel reveal can show
// instant sell-back offers for all reels without additional requests.
//
// AUTH: authenticated by the '/store/packs/*/open-batch' matcher in
// middlewares.ts (bearer-only, same as the single-open route). customerId is
// taken ONLY from the verified token — never from the body/params.
//
// count validation lives here (HTTP boundary concern — simple integer range
// check). Business validation (pack active, odds present, sufficient credit)
// lives in the workflow steps and surfaces as mapped MedusaErrors.

const MAX_COUNT = 3;

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.auth_context.actor_id;
  const { slug } = req.params;

  const raw = (req.body as { count?: unknown } | undefined)?.count;
  const count = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `'count' must be an integer between 1 and ${MAX_COUNT}.`,
    );
  }

  const { result } = await openBatchWorkflow(req.scope).run({
    input: { pack_id: slug, customer_id: customerId, count },
  });

  const packsService = req.scope.resolve<PacksModuleService>(PACKS_MODULE);

  // ⚠ EVERYTHING BELOW IS POST-COMMIT — the workflow has ALREADY debited the
  // customer and written the pull rows, and nothing here can roll that back.
  // So a failure below must NOT fail the request: the player paid and the cards
  // ARE in their vault, and throwing would show them a generic error instead of
  // their reveal — reading as a lost charge. Degrade instead, and log loudly (a
  // silent catch would hide a systemic quoting outage behind "every buyback is
  // degraded"). Cards drop marketPriceMyr, which the storefront renders as '—'
  // rather than showing raw USD behind "RM"; each quote degrades to
  // UNQUOTED_BUYBACK (firm: false — see its comment for why NOT null).
  let rolls;
  try {
    // Belt-and-braces invariant: also post-commit, so it degrades rather than
    // 500s a customer who has already been charged.
    if (result.rolls.length !== result.pulls.length) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        'open-batch workflow returned mismatched rolls/pulls.',
      );
    }

    // Quote a buyback offer for each roll from the same helper the buyback
    // workflow uses (packsService.quoteBuyback), so the multi-reveal's
    // "sell on the spot" numbers are authoritative and can never disagree with
    // what selling actually credits. Mirror the single-open route's per-pull
    // pattern byte-for-byte: toMoney-wrap market_value before passing it to
    // quoteBuyback, then attach vault_percent / vault_amount / instant_deadline_ms.
    //
    // Display-only live MYR price per roll — fxRate resolved ONCE for the whole
    // batch, and the won cards' market_multiplier fetched in a single batched
    // lookup (RolledCard, the roll-pack-batch step's winner shape, does not
    // carry market_multiplier — same gap as the single-open route).
    const { rate: fxRate, firm: fxFirm } =
      await resolveFxRateInfo(packsService);
    const handles = [...new Set(result.rolls.map((card) => card.handle))];
    const cardRows = handles.length
      ? await packsService.listCards(
          { handle: handles },
          { take: handles.length },
        )
      : [];
    const multiplierByHandle = new Map(
      cardRows.map((c) => [
        c.handle,
        Number(c.market_multiplier ?? DEFAULT_MARKET_MULTIPLIER),
      ]),
    );

    rolls = await Promise.all(
      result.rolls.map(async (card, i) => {
        const pull = result.pulls[i];
        const marketValue = toMoney(card.market_value);
        // MYR Value first — buyback (instant + flat) is a cut of the shown Value,
        // not raw USD, so it must be quoted off this, matching what selling credits.
        const marketPriceMyr = displayMarketPrice(
          marketValue,
          fxRate,
          multiplierByHandle.get(card.handle) ?? DEFAULT_MARKET_MULTIPLIER,
        );
        const buyback = await packsService.quoteBuyback(
          slug,
          {
            rolled_at: pull.rolled_at,
            revealed_at: pull.revealed_at,
            // Freshly rolled here, so the window is definitionally open — the
            // batch's PullRecord doesn't carry the column, and null is exact.
            instant_closed_at: null,
          },
          marketPriceMyr,
        );
        return {
          pull,
          card: { ...card, marketPriceMyr },
          buyback: {
            ...buyback,
            // Mirrors the single-open route: false when the amounts were computed
            // on the display FX fallback — the sell would refuse, so don't
            // present the quote as firm (sim finding P1-1).
            firm: fxFirm,
            vault_percent: FLAT_PERCENT,
            vault_amount: buybackAmount(marketPriceMyr, FLAT_PERCENT),
            instant_deadline_ms: instantDeadlineMs(
              pull.rolled_at,
              pull.revealed_at,
            ),
          },
        };
      }),
    );
  } catch (err) {
    req.scope
      .resolve(ContainerRegistrationKeys.LOGGER)
      .error(
        `[open-batch] post-commit enrichment failed for '${slug}' (customer ${customerId}) — serving ${result.rolls.length} PAID roll(s) with a degraded buyback`,
        err instanceof Error ? err : new Error(String(err)),
      );
    rolls = result.rolls.map((card, i) => ({
      pull: result.pulls[i] ?? null,
      card,
      buyback: UNQUOTED_BUYBACK,
    }));
  }

  res.json({
    rolls,
    price: result.price,
    total_charged: result.total,
    balance: result.balance,
  });
}
