import { TransactionState } from '@medusajs/framework/utils';
import { finalizeOpenPulls } from '../finalize-open-pulls';
import type PacksModuleService from '../service';

it('only finalizes a successful terminal workflow, and preserves a paid result on marker failure', async () => {
  const marker = jest.fn().mockResolvedValue(undefined);
  const service = { finalizePullsForCoinFlip: marker } as unknown as PacksModuleService;
  const logger = { error: jest.fn() };
  const input = { customerId: 'customer', pullIds: ['pull'], expectedCount: 1 };
  for (const state of Object.values(TransactionState)) {
    if (state === TransactionState.DONE) continue;
    await finalizeOpenPulls(service, { transaction: { getState: () => state } }, input, logger);
  }
  const transaction = { getState: () => TransactionState.DONE };
  await finalizeOpenPulls(service, { transaction, errors: [new Error('tail failed')] }, input, logger);
  await finalizeOpenPulls(service, { transaction, thrownError: new Error('tail failed') }, input, logger);
  expect(marker).not.toHaveBeenCalled();
  await finalizeOpenPulls(service, { transaction }, input, logger);
  expect(marker).toHaveBeenCalledWith(input);
  marker.mockRejectedValueOnce(new Error('database unavailable'));
  await expect(finalizeOpenPulls(service, { transaction }, input, logger)).resolves.toBeUndefined();
  expect(logger.error).toHaveBeenCalledTimes(1);
});
