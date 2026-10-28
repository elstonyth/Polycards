import { TransactionState } from '@medusajs/framework/utils';
import type PacksModuleService from './service';

export async function finalizeOpenPulls(
  service: PacksModuleService,
  run: { transaction: { getState(): TransactionState }; thrownError?: unknown; errors?: unknown[] },
  input: { customerId: string; pullIds: string[]; expectedCount: number },
  logger: { error(message: string, error?: Error): unknown },
): Promise<void> {
  try {
    if (run.transaction.getState() !== TransactionState.DONE || run.thrownError != null || (run.errors?.length ?? 0) !== 0) return;
    if (input.pullIds.length !== input.expectedCount) throw new Error('Completed pull count mismatch.');
    await service.finalizePullsForCoinFlip(input);
  } catch (error) {
    // The paid open already succeeded; keep its response and leave flip eligibility closed.
    logger.error(`Coin flip finalization requires repair for ${input.pullIds.join(',')}.`, error instanceof Error ? error : new Error(String(error)));
  }
}
