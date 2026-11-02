import type {
  ICustomerModuleService,
  MedusaContainer,
} from '@medusajs/framework/types';
import {
  ContainerRegistrationKeys,
  MedusaError,
  Modules,
} from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../modules/packs';
import type PacksModuleService from '../../modules/packs/service';
import {
  resolveFxRate,
  resolveFxRateStrict,
} from '../../modules/packs/pricing';
import { openPackWorkflow } from '../../workflows/open-pack';
import { buybackPullWorkflow } from '../../workflows/buyback-pull';
import { monitoredCustomerIds } from './automation-monitor';
import {
  beginLiveRound,
  canRepeatLiveRound,
  claimLiveCycle,
  completeLiveCycle,
  createLiveState,
  executeLiveCycle,
  pickLivePack,
  validateLiveConfig,
} from './automation-live';
import type {
  LiveConfig,
  LiveCycle,
  LiveSnapshot,
  LiveState,
} from './automation-live-types';
import { pageAll } from './page-all';
import { rememberHumanizedAssignments } from './automation-humanized';
import { observeLiveRanks } from './automation-live-leaderboard';
import {
  liveRankTargetsToObserve,
  refreshLiveRankGoals,
} from './automation-live-rank';

interface Connection {
  raw(
    sql: string,
    bindings?: unknown[],
  ): Promise<{ rows: { state: unknown }[] }>;
}
interface Database extends Connection {
  transaction<T>(callback: (transaction: Connection) => Promise<T>): Promise<T>;
}
const invalid = (message: string) =>
  new MedusaError(MedusaError.Types.INVALID_DATA, message);
const service = (container: MedusaContainer) =>
  container.resolve<PacksModuleService>(PACKS_MODULE);
const database = (container: MedusaContainer) =>
  container.resolve<Database>(ContainerRegistrationKeys.PG_CONNECTION);

function decode(value: unknown): LiveState {
  if (
    !value ||
    typeof value !== 'object' ||
    !('version' in value) ||
    value.version !== 1 ||
    !('mode' in value) ||
    value.mode !== 'live'
  )
    throw new Error('Unsupported live workspace state.');
  return value as LiveState;
}

async function selectedCustomers(packs: PacksModuleService): Promise<string[]> {
  const [saved] = await packs.listAutomationMonitors(
    { id: 'global' },
    { take: 1 },
  );
  return monitoredCustomerIds(saved?.accounts);
}

async function editLive<T>(
  container: MedusaContainer,
  actorId: string,
  change: (state: LiveState) => T,
): Promise<T> {
  return database(container).transaction(async (transaction) => {
    await transaction.raw(`set local lock_timeout = '5s'`);
    await transaction.raw(
      `insert into automation_live (id, state, updated_by) values ('global', ?::jsonb, ?) on conflict (id) do nothing`,
      [JSON.stringify(createLiveState()), actorId],
    );
    const { rows } = await transaction.raw(
      `select state from automation_live where id = 'global' and deleted_at is null for update`,
    );
    if (rows.length !== 1) throw new Error('Live workspace unavailable.');
    const state = decode(rows[0].state);
    const result = change(state);
    await transaction.raw(
      `update automation_live set state = ?::jsonb, updated_by = ?, updated_at = now() where id = 'global'`,
      [JSON.stringify(state), actorId],
    );
    return result;
  });
}

export async function readLive(
  container: MedusaContainer,
): Promise<LiveSnapshot> {
  const packs = service(container);
  const { rows } = await database(container).raw(
    `select state from automation_live where id = 'global' and deleted_at is null`,
  );
  const state = rows.length ? decode(rows[0].state) : createLiveState();
  const ids = await selectedCustomers(packs);
  const customerService = container.resolve<ICustomerModuleService>(
    Modules.CUSTOMER,
  );
  const [catalog, customers] = await Promise.all([
    pageAll((opts) =>
      packs.listPacks({ status: 'active', in_stock: true }, opts),
    ),
    ids.length
      ? customerService.listCustomers(
          { id: ids, has_account: true },
          { select: ['id', 'email', 'first_name', 'last_name'], take: 80 },
        )
      : [],
  ]);
  const overview = await packs.playersOverview(
    customers.map((customer) => customer.id),
    await resolveFxRate(packs),
  );
  return {
    ...state,
    packs: catalog
      .filter(
        (pack) =>
          !['reward_box', 'free_welcome'].includes(pack.category) &&
          // A cycle needs a pull and a card to sell. A spin has neither.
          pack.prize_type !== 'tickets' &&
          Number.isFinite(Number(pack.price)) &&
          Number(pack.price) > 0,
      )
      .map((pack) => ({
        slug: pack.slug,
        title: pack.title,
        price: Number(pack.price),
      })),
    accounts: customers.map((customer) => {
      const account = overview.state.get(customer.id);
      return {
        id: customer.id,
        name:
          [customer.first_name, customer.last_name].filter(Boolean).join(' ') ||
          customer.email,
        balance: (overview.wallet.get(customer.id)?.balanceCents ?? 0) / 100,
        status: account?.disabled
          ? 'disabled'
          : account?.frozen
            ? 'frozen'
            : 'active',
      };
    }),
  };
}

/** Pack prices and accounts for a round, read now. On Run every selected
 *  account must be active; a repeated round drops the ones that no longer are. */
async function liveRoundSettings(
  container: MedusaContainer,
  config: LiveConfig,
  dropInactive: boolean,
): Promise<
  Pick<LiveState, 'packPriceCents' | 'packPricesCents'> & { config: LiveConfig }
> {
  const snapshot = await readLive(container);
  const catalog = new Map(
    snapshot.packs.map((pack) => [pack.slug, Math.round(pack.price * 100)]),
  );
  const mix = config.packMix ?? [{ packSlug: config.packSlug, weightBp: 1 }];
  if (mix.some((row) => !catalog.has(row.packSlug)))
    throw new Error(
      'Choose available paid card packs: active, in stock, not a ticket pack.',
    );
  const packPricesCents = Object.fromEntries(
    mix.map((row) => [row.packSlug, catalog.get(row.packSlug)!]),
  );
  const active = new Set(
    snapshot.accounts
      .filter((account) => account.status === 'active')
      .map((account) => account.id),
  );
  if (!dropInactive && config.customerIds.some((id) => !active.has(id)))
    throw new Error(
      'Every selected account must exist and be active and unfrozen.',
    );
  const customerIds = config.customerIds.filter((id) => active.has(id));
  if (!customerIds.length)
    throw new Error('No selected account is active any more.');
  return {
    config: {
      ...config,
      customerIds,
      ...(config.rankTargets && {
        rankTargets: config.rankTargets.filter((target) =>
          active.has(target.customerId),
        ),
      }),
    },
    packPricesCents,
    // A mix's weighted average stands in for "the pack price" in rank estimates.
    packPriceCents: Math.round(
      mix.reduce(
        (sum, row) => sum + packPricesCents[row.packSlug] * row.weightBp,
        0,
      ) / mix.reduce((sum, row) => sum + row.weightBp, 0),
    ),
  };
}

export async function changeLive(
  container: MedusaContainer,
  input: unknown,
  actorId: string,
): Promise<void> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw invalid('Choose a live action.');
  const body = input as Record<string, unknown>;
  if (
    !['save', 'run', 'pause', 'resume', 'stop'].includes(String(body.action)) ||
    Object.keys(body).some((key) => !['action', 'config'].includes(key)) ||
    (!['save', 'run'].includes(String(body.action)) &&
      body.config !== undefined)
  )
    throw invalid('Unsupported live action.');
  const packs = service(container);
  let round: Awaited<ReturnType<typeof liveRoundSettings>> | undefined;
  if (body.action === 'save' || body.action === 'run') {
    let config;
    try {
      config = validateLiveConfig(body.config, await selectedCustomers(packs));
      round = await liveRoundSettings(container, config, false);
    } catch (error) {
      throw invalid(
        error instanceof Error ? error.message : 'Invalid live settings.',
      );
    }
    if (body.action === 'run') await resolveFxRateStrict(packs);
  }
  await editLive(container, actorId, (state) => {
    if (body.action === 'stop') {
      state.status = 'stopped';
      state.nextRunAt = null;
      return;
    }
    if (body.action === 'pause') {
      if (state.status !== 'running')
        throw invalid('Only a running live run can be paused.');
      state.status = 'paused';
      return;
    }
    if (state.pending)
      throw invalid(
        `Cycle ${state.pending.id} is settling or needs review. A new draw cannot start.`,
      );
    if (body.action === 'resume') {
      if (state.status !== 'paused')
        throw invalid('Only a paused live run can be resumed.');
      state.status = 'running';
      state.nextRunAt = Date.now();
      return;
    }
    if (state.status === 'running' || state.status === 'paused')
      throw invalid('Stop the current live run before editing settings.');
    if (!round) throw invalid('Live settings required.');
    for (const row of state.schedules ?? [])
      row.humanized.regionChoice ??= state.config?.humanizedRegion ?? 'mysg';
    state.humanizedAssignments = rememberHumanizedAssignments(
      state.humanizedAssignments ?? [],
      state.schedules?.map((row) => row.humanized) ?? [],
    );
    if (body.action === 'run') beginLiveRound(state, round, Date.now(), false);
    else Object.assign(state, round);
  });
}

export async function tickLive(
  container: MedusaContainer,
  clock: () => number = Date.now,
): Promise<boolean> {
  const claimed = await database(container).transaction(async (transaction) => {
    const { rows } = await transaction.raw(
      `select state from automation_live where id = 'global' and deleted_at is null and (state->>'status' = 'running' or state->'pending'->>'id' is not null) for update skip locked`,
    );
    if (!rows.length) return null;
    const state = decode(rows[0].state);
    const previous = JSON.stringify(state);
    if (
      state.status === 'running' &&
      !state.pending &&
      state.config?.rankTargets?.length &&
      (state.nextRunAt ?? 0) <= clock()
    ) {
      const targets = liveRankTargetsToObserve(state, clock());
      const observations = await observeLiveRanks(
        service(container),
        targets,
        clock,
      );
      refreshLiveRankGoals(state, observations, clock());
    }
    const cycle = claimLiveCycle(state, clock());
    if (!cycle && canRepeatLiveRound(state)) {
      // Always-on: the finished round starts the next at today's prices.
      try {
        const round = await liveRoundSettings(container, state.config!, true);
        await resolveFxRateStrict(service(container));
        beginLiveRound(state, round, clock(), true);
      } catch (error) {
        state.error = `Next round not started: ${
          error instanceof Error ? error.message : 'settings unavailable'
        }`;
      }
    }
    if (!cycle && JSON.stringify(state) === previous) return null;
    await transaction.raw(
      `update automation_live set state = ?::jsonb, updated_at = now() where id = 'global'`,
      [JSON.stringify(state)],
    );
    return cycle && state.config
      ? {
          cycle,
          config: state.config,
          runId: state.runId,
          // Runs started before per-pack prices existed carry only packPriceCents.
          pricesCents: state.packPricesCents ?? {
            [state.config.packSlug]: state.packPriceCents,
          },
        }
      : null;
  });
  if (!claimed) return false;
  const packs = service(container);
  const cycle: LiveCycle = { ...claimed.cycle };
  const checkpoint = async () =>
    editLive(container, 'worker', (state) => {
      if (state.runId !== claimed.runId || state.pending?.id !== cycle.id)
        throw new Error('Live cycle ownership changed.');
      state.pending = { ...cycle };
    });
  try {
    if (
      !(await selectedCustomers(packs)).includes(cycle.customerId) ||
      (await packs.isAccountDisabled(cycle.customerId))
    )
      throw new Error('Account is no longer selected or is disabled.');
    const [account] = await packs.listCustomerAccountStates(
      { customer_id: cycle.customerId },
      { take: 1 },
    );
    if (account?.frozen) throw new Error('Account is frozen.');
    await resolveFxRateStrict(packs);
    const balanceCents = Math.round(
      (await packs.creditSummary(cycle.customerId)).balance * 100,
    );
    const packSlug = claimed.config.packMix
      ? pickLivePack(claimed.config.packMix, claimed.pricesCents, balanceCents)
      : claimed.config.packSlug;
    cycle.packSlug = packSlug;
    const priceCents = claimed.pricesCents[packSlug];
    // Checked before any money moves: one empty wallet must not stop the
    // other accounts, so it only ends this account's draws for the run.
    if (balanceCents < priceCents) {
      cycle.skipped = `Balance RM ${(balanceCents / 100).toFixed(2)} cannot cover RM ${(priceCents / 100).toFixed(2)}. No more draws for this account in this run.`;
    } else {
      const amounts = await executeLiveCycle(
        cycle.customerId,
        cycle.id,
        priceCents / 100,
        {
          balance: () => packs.creditSummary(cycle.customerId),
          open: async (customerId, openId, maxPrice) => {
            const { result } = await openPackWorkflow(container).run({
              input: {
                customer_id: customerId,
                pack_id: packSlug,
                open_id: openId,
                max_price: maxPrice,
              },
            });
            // Only this newly committed draw is revealed; never scan past cycles.
            try {
              const revealed = await packs.revealPull(result.pull.id, customerId);
              if (revealed.first_reveal) {
                await container.resolve(Modules.EVENT_BUS).emit({
                  name: 'pull.revealed',
                  data: {
                    pull_id: result.pull.id,
                    pack_id: packSlug,
                    card_id: result.card.handle,
                    customer_id: customerId,
                  },
                });
              }
            } catch (error) {
              // An announcement failure must not interrupt the paid draw's settlement.
              container.resolve(ContainerRegistrationKeys.LOGGER).warn(
                `Live automation announcement dropped for pull ${result.pull.id}: ${
                  error instanceof Error ? error.message : 'reveal unavailable'
                }`,
              );
            }
            return {
              pullId: result.pull.id,
              cardName: result.card.name,
              price: result.price,
              bonusUsed: result.bonus_cents / 100,
            };
          },
          checkpoint: async (result) => {
            Object.assign(cycle, result);
            await checkpoint();
          },
          sell: async (customerId, pullId) => {
            if (await packs.isAccountDisabled(customerId))
              throw new Error(
                'Account was disabled before settlement. The paid card remains in the vault.',
              );
            const { result } = await buybackPullWorkflow(container).run({
              input: { customer_id: customerId, pull_id: pullId },
            });
            return result;
          },
        },
      );
      Object.assign(cycle, amounts);
    }
  } catch (error) {
    // Workflow failures arrive as plain objects, not Error instances.
    const message =
      error && typeof error === 'object' && 'message' in error
        ? String(error.message)
        : '';
    cycle.error = message || 'Live cycle failed.';
    container
      .resolve(ContainerRegistrationKeys.LOGGER)
      .error(`Live automation cycle ${cycle.id}: ${cycle.error}`);
  }
  await editLive(container, 'worker', (state) => {
    if (state.runId !== claimed.runId)
      throw new Error('Live run changed during settlement.');
    completeLiveCycle(state, cycle, clock());
  });
  return true;
}
