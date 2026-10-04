import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import {
  renderTasksPoster,
  splitWeeklyTasks,
  taskWeekLabel,
} from '../../../../modules/packs/tasks-poster';
import { taskCatalogue } from '../tasks/catalogue';

// GET /reports/growth/tasks-poster: the week's live tasks as a posting poster
// (tasks-poster.ts): the check-in tiers as one strip, then a tile per other
// weekly task, each with its prize and what /task says it is worth. Nothing
// on it is typed in. x-poster-missing-art names prizes drawn as a plain gift
// box ('checkin:<days>', 'task:<index>'); x-poster-note says in plain words
// what was left off.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const { week_start, tasks } = await taskCatalogue(packs);
  const weekly = tasks.filter((t) => t.kind === 'weekly');
  // A free rip or card whose pack or card is gone cannot be claimed, so it
  // never goes on a public poster.
  const gone = weekly.filter(
    (t) => t.prize_type !== 'credit' && t.value_myr === null,
  );
  const live = weekly.filter((t) => !gone.includes(t));
  if (!live.length) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      gone.length
        ? `Every weekly task has a prize that no longer exists (${gone.map((t) => t.title).join(', ')}): fix them in the admin Tasks console.`
        : 'No weekly tasks are live on the /task page right now.',
    );
  }
  const { checkins, tasks: others } = splitWeeklyTasks(live);
  const { jpeg, missing, dropped } = await renderTasksPoster(
    {
      weekLabel: taskWeekLabel(week_start),
      checkins,
      tasks: others,
      siteHost: 'polycards.gg/task',
    },
    {
      checkins: checkins.map((c) => c.task.image),
      tasks: others.map((t) => t.task.image),
    },
  );
  const notes: string[] = [];
  if (gone.length) {
    notes.push(
      `Left off because the prize no longer exists: ${gone.map((t) => t.title).join(', ')}. Tell staff to fix it in the admin Tasks console.`,
    );
  }
  if (dropped) {
    notes.push(
      `${dropped} task${dropped === 1 ? '' : 's'} did not fit on the poster: ${others
        .slice(others.length - dropped)
        .map((t) => t.task.title)
        .join(', ')}.`,
    );
  }
  res.setHeader('Content-Type', 'image/jpeg');
  if (missing.length) res.setHeader('x-poster-missing-art', missing.join(','));
  // A header carries plain ASCII only.
  if (notes.length) {
    res.setHeader(
      'x-poster-note',
      notes.join(' ').replace(/[^\x20-\x7e]/g, '-'),
    );
  }
  res.status(200).send(jpeg);
}
