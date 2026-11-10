/**
 * A step that did nothing must hand its compensator nothing (audit 2026-11-11,
 * the #968 class). With `undefined` compensate data Medusa passes the step's
 * OUTPUT to the compensator instead, so a `!data` guard let through
 * `releasePackGifts(undefined)` and `adjustInventory(undefined, undefined, 1)`
 * on every rolled-back open. Each step now sends `null`. These run the real
 * steps inside a workflow whose next step throws, so Medusa itself drives
 * the compensation.
 */
import { createMedusaContainer } from '@medusajs/framework/utils';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import {
  createStep,
  createWorkflow,
  WorkflowResponse,
} from '@medusajs/framework/workflows-sdk';
import { asValue } from 'awilix';
import { PACKS_MODULE } from '../../modules/packs';
import { claimPackGiftsStep } from '../steps/claim-pack-gifts';
import { decrementCardStockStep } from '../steps/decrement-card-stock';

jest.setTimeout(30000);

const boom = createStep('compensate-null-boom', async () => {
  throw new Error('later step failed');
});

const rollback = createWorkflow('compensate-null-test', () => {
  claimPackGiftsStep({
    customer_id: 'cus_1',
    pack_id: 'pack',
    gifts: 0,
    open_id: 'open_1',
  });
  decrementCardStockStep({ card_id: 'untracked-card', pull_id: 'pull_1' });
  boom();
  return new WorkflowResponse(undefined);
});

it('compensates a gift-less, untracked open without touching gifts or stock', async () => {
  const releasePackGifts = jest.fn();
  const raw = jest.fn().mockResolvedValue({ rowCount: 1 });
  const container = createMedusaContainer();
  container.register({
    [PACKS_MODULE]: asValue({ releasePackGifts, updatePulls: jest.fn() }),
    // No product for the card: decrement takes no unit.
    [ContainerRegistrationKeys.QUERY]: asValue({
      graph: async () => ({ data: [] }),
    }),
    [ContainerRegistrationKeys.PG_CONNECTION]: asValue({ raw }),
    [ContainerRegistrationKeys.LOGGER]: asValue({
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    }),
  });

  const { errors } = await rollback(container).run({ throwOnError: false });

  // Only the step that threw: no compensator failed on the way back.
  expect(errors.map((e) => e.error?.message)).toEqual(['later step failed']);
  expect(releasePackGifts).not.toHaveBeenCalled();
  expect(raw).not.toHaveBeenCalled();
});
