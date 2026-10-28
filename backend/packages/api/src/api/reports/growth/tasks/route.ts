import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import { assetOrigin } from '../../../utils/image-fetch';
import { catalogueAt, taskCatalogue } from './catalogue';

// A stored picture is often storefront-relative; the bot needs a full link.
const absolute = (url: string | null): string | null =>
  url?.startsWith('/') ? `${assetOrigin()}${url}` : url;

// GET /reports/growth/tasks?week=current|next: the daily and weekly tasks and
// achievements exactly as the /task page shows them right now (or, with
// week=next, as it will show them at next Monday 00:00 MYT), with each prize,
// what the page says it is worth and its official picture. The catalogue
// only: nobody's progress.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const at = catalogueAt(req.query.week);
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const { week_start, tasks } = await taskCatalogue(packs, at);
  const strip = ({ kind: _kind, image, ...t }: (typeof tasks)[number]) => ({
    ...t,
    image: absolute(image),
  });
  res.json({
    week_start,
    achievements: tasks.filter((t) => t.kind === 'achievement').map(strip),
    weekly: tasks.filter((t) => t.kind === 'weekly').map(strip),
    daily: tasks.filter((t) => t.kind === 'daily').map(strip),
    note: `${
      req.query.week === 'next'
        ? 'Next week: the tasks switched on whose run window covers next Monday 00:00 Malaysia time, as the /task page will show them then.'
        : 'Live tasks only (switched on and inside their run window), as the /task page shows them.'
    } Achievements are claimed once per account; level is the VIP level a reach_level achievement needs. Daily tasks reset every day at 00:00 Malaysia time; weekly tasks every Monday 00:00; ends_at is when a task stops showing. value_myr is today's value as the page shows it: a credit's amount, a free rip's pack price, a card's market price today (it moves with the market). tickets is how many Lucky Draw tickets a claim also pays; prize already says so when it is above 0, and value_myr does not count them. achievements_poster draws the VIP-level ladder.`,
  });
}
