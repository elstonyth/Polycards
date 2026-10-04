import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../modules/packs';
import { posterWeekLabel } from '../../../../modules/packs/challenge-poster';
import {
  artKey,
  renderStagesPoster,
  stageBlock,
  stagesHeadline,
} from '../../../../modules/packs/challenge-stages-poster';
import type PacksModuleService from '../../../../modules/packs/service';
import { buildChallengeView } from '../../../store/challenge/build';
import { nextQueuedChallenge } from '../challenge/queued';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

type Stage = {
  stageNumber: number;
  thresholdMyr: number;
  rankRewards: { rank: number; cardId: string | null; credits: number }[];
};

// GET /reports/growth/challenge-stages-poster?week=current|next: every stage
// of the running Weekly Challenge (or, with week=next, the next one waiting in
// the admin queue) on one poster, each with its threshold, its #1-#3 prizes as
// the official card art and what ranks 4-10 win (challenge-stages-poster.ts).
// x-poster-missing-art names 'stage:rank' prizes drawn as a placeholder.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const which = req.query.week ?? 'current';
  if (which !== 'current' && which !== 'next') {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'week must be current (the running week) or next (the next one queued).',
    );
  }
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  let weekLabel: string;
  let stages: Stage[];
  let cards: Record<string, { name: string; image: string | null }>;
  let unlocked: (s: Stage) => boolean;
  if (which === 'next') {
    const queued = await nextQueuedChallenge(packs);
    if (!queued || !queued.stages.length) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        'No challenge is waiting in the admin queue.',
      );
    }
    const settings = await packs.challengeSettings();
    weekLabel = posterWeekLabel(
      queued.startsAt,
      new Date(queued.startsAt.getTime() + WEEK_MS),
      settings.timezone,
    );
    stages = queued.stages;
    cards = queued.cards;
    unlocked = () => false;
  } else {
    const { body, week } = await buildChallengeView(req.scope);
    if (!body.active) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        'The Weekly Pulled Value Challenge has no stages set up.',
      );
    }
    const bounds = await packs.challengeWeekBounds(week);
    weekLabel = posterWeekLabel(
      bounds.startUtc,
      bounds.endUtc,
      body.settings.timezone,
    );
    stages = body.stages;
    cards = body.cards;
    const pool = body.progress.pooledMyr;
    unlocked = (s) => pool >= s.thresholdMyr;
  }

  const urls = new Map<string, string | null>();
  for (const s of stages) {
    for (const r of s.rankRewards) {
      if (r.rank <= 3 && r.cardId) {
        urls.set(artKey(s.stageNumber, r.rank), cards[r.cardId]?.image ?? null);
      }
    }
  }
  const { jpeg, missing } = await renderStagesPoster(
    {
      weekLabel,
      headline: stagesHeadline(stages.length),
      stages: stages.map((s) => stageBlock(s, cards, unlocked(s))),
      siteHost: 'polycards.gg/leaderboard',
    },
    urls,
  );
  res.setHeader('Content-Type', 'image/jpeg');
  if (missing.length) res.setHeader('x-poster-missing-art', missing.join(','));
  res.status(200).send(jpeg);
}
