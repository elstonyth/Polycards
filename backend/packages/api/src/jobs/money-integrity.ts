import { MedusaContainer } from '@medusajs/framework/types';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../modules/packs';
import type PacksModuleService from '../modules/packs/service';
import {
  moneyIntegrityFindings,
  type IntegrityFinding,
} from '../modules/packs/money-integrity';
import { alertOps } from '../modules/packs/ops-alert';

const ALERT_EVERY_MS = 24 * 60 * 60 * 1000;

const WORDS: Record<IntegrityFinding['kind'], string> = {
  open_without_prize: 'Open charged with no card or spin recorded',
  sold_without_flip: 'Sell-back paid but the card was not marked sold',
  denied_without_refund: 'Payout denied but its refund never landed',
};

/**
 * Hourly look for money left half-moved by a crash (modules/packs/money-integrity).
 * Never moves money. Settlement and the Dashboard show the same list.
 */
export default async function moneyIntegrityJob(container: MedusaContainer) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
  for (const f of await moneyIntegrityFindings(packs)) {
    const text = `${WORDS[f.kind]}: ${f.id}, RM ${f.amount}. See Settlement.`;
    logger.error(`[money-integrity] ${text}`);
    await alertOps(container, `money-integrity:${f.id}`, text, {
      muteMs: ALERT_EVERY_MS,
    });
  }
}

export const config = {
  name: 'money-integrity',
  schedule: '35 * * * *',
};
