import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk';
import { PACKS_MODULE } from '../../modules/packs';
import type PacksModuleService from '../../modules/packs/service';

export type StampPackGiftsInput = {
  open_id: string;
  /** Each claimed gift and the pull it became (the open's first rows). */
  pairs: { giftId: string; pullId: string }[];
};

type CompensateData = { open_id: string } | undefined;

// stamp-pack-gifts — record which pull each claimed gift became (spec
// 2026-10-07 §5). Its OWN step, after record-pulls-batch: a step's
// compensation never runs when that step itself throws, so a stamp failure
// inside the record step would orphan the pulls it had just written. Here a
// failure rolls back the record step (pulls deleted), the charge (reversed)
// and the claim (released). Its own undo clears the stamps.
export const stampPackGiftsStep = createStep<
  StampPackGiftsInput,
  void,
  CompensateData
>(
  'stamp-pack-gifts',
  async (input, { container }) => {
    if (input.pairs.length === 0) {
      return new StepResponse(undefined, undefined as CompensateData);
    }
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    await packs.stampPackGiftPulls({
      openId: input.open_id,
      pairs: input.pairs,
    });
    return new StepResponse(undefined, { open_id: input.open_id });
  },
  async (data, { container }) => {
    if (!data) return;
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    await packs.unstampPackGiftPulls(data.open_id);
  },
);

export default stampPackGiftsStep;
