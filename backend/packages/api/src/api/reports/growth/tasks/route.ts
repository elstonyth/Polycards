import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import { taskCatalogue } from './catalogue';

// GET /reports/growth/tasks: the weekly tasks and achievements exactly as the
// /task page shows them right now, with each prize, what the page says it is
// worth and its official picture. The catalogue only: nobody's progress.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const { week_start, tasks } = await taskCatalogue(packs);
  const strip = ({ kind: _kind, ...t }: (typeof tasks)[number]) => t;
  res.json({
    week_start,
    achievements: tasks.filter((t) => t.kind === 'achievement').map(strip),
    weekly: tasks.filter((t) => t.kind === 'weekly').map(strip),
    note: "Live tasks only (switched on and inside their run window), as the /task page shows them. Achievements are claimed once per account; level is the VIP level a reach_level achievement needs. Weekly tasks reset every Monday 00:00 Malaysia time; ends_at is when a task stops showing. value_myr is today's value as the page shows it: a credit's amount, a free rip's pack price, a card's market price today (it moves with the market). achievements_poster draws the VIP-level ladder.",
  });
}
