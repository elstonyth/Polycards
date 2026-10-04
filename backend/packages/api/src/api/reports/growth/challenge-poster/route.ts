import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import {
  posterHeadline,
  posterWeekLabel,
  renderChallengePoster,
} from '../../../../modules/packs/challenge-poster';
import { buildChallengeView } from '../../../store/challenge/build';
import { nextQueuedChallenge } from '../challenge/queued';

// GET /reports/growth/challenge-poster?stage=&leaders=0|1: the running Weekly
// Pulled Value Challenge as a finished poster JPEG for the Growth desk bot to
// post as a draft. Built from the same view as the public Ranks page, with
// each podium prize's official image (modules/packs/challenge-poster.ts).
// stage defaults to the highest unlocked stage; leaders adds the current top 3
// shown names. ?week=next draws the next challenge waiting in the admin queue
// instead (queuedPoster). x-poster-missing-art names podium ranks whose prize
// card shows as a placeholder tile (art that could not be fetched or decoded).
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const { stage, leaders } = req.query;
  if (
    stage !== undefined &&
    (typeof stage !== 'string' || !/^\d{1,2}$/.test(stage))
  ) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'stage must be a stage number.',
    );
  }
  if (leaders !== undefined && leaders !== '0' && leaders !== '1') {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'leaders must be 0 or 1.',
    );
  }
  const which = req.query.week ?? 'current';
  if (which !== 'current' && which !== 'next') {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'week must be current (the running week) or next (the next one queued).',
    );
  }
  if (which === 'next') {
    await queuedPoster(req, res, stage as string | undefined);
    return;
  }
  const { body, week } = await buildChallengeView(req.scope);
  if (!body.active) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      'The Weekly Pulled Value Challenge has no stages set up.',
    );
  }
  const pool = body.progress.pooledMyr;
  const { headline, featureStage } = posterHeadline(body.stages, pool);
  const feature = body.stages.find(
    (s) =>
      s.stageNumber === (stage === undefined ? featureStage : Number(stage)),
  );
  if (!feature) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `There is no stage ${stage}. Stages: ${body.stages.map((s) => s.stageNumber).join(', ')}.`,
    );
  }

  const podium = ([1, 2, 3] as const).map((rank) => {
    const reward = feature.rankRewards.find((r) => r.rank === rank);
    const card = reward?.cardId ? body.cards[reward.cardId] : undefined;
    return {
      rank,
      name: card?.name ?? null,
      credits: reward?.credits ?? 0,
      image: card?.image ?? null,
    };
  });
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const bounds = await packs.challengeWeekBounds(week);

  const { jpeg, missing } = await renderChallengePoster(
    {
      headline,
      weekLabel: posterWeekLabel(
        bounds.startUtc,
        bounds.endUtc,
        body.settings.timezone,
      ),
      stages: body.stages.map((s) => ({
        stage: s.stageNumber,
        unlocked: pool >= s.thresholdMyr,
      })),
      featureStage: feature.stageNumber,
      podium: podium.map(({ rank, name, credits }) => ({
        rank,
        name,
        credits,
      })),
      leaders:
        leaders === '1'
          ? body.top.slice(0, 3).map((t) => ({ rank: t.rank, name: t.name }))
          : [],
      siteHost: 'polycards.gg/leaderboard',
    },
    new Map(podium.map((p) => [p.rank, p.image])),
  );
  res.setHeader('Content-Type', 'image/jpeg');
  if (missing.length) res.setHeader('x-poster-missing-art', missing.join(','));
  res.status(200).send(jpeg);
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** The poster of the next challenge waiting in the admin queue: its own
 *  week's dates, every stage still locked (its pool starts at 0), stage 1
 *  featured unless `stage` says otherwise, and no leaders yet. */
async function queuedPoster(
  req: MedusaRequest,
  res: MedusaResponse,
  stage: string | undefined,
): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const queued = await nextQueuedChallenge(packs);
  if (!queued || !queued.stages.length) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      'No challenge is waiting in the admin queue.',
    );
  }
  const { headline, featureStage } = posterHeadline(queued.stages, 0);
  const feature = queued.stages.find(
    (s) =>
      s.stageNumber === (stage === undefined ? featureStage : Number(stage)),
  );
  if (!feature) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `The queued challenge has no stage ${stage}. Stages: ${queued.stages.map((s) => s.stageNumber).join(', ')}.`,
    );
  }
  const podium = ([1, 2, 3] as const).map((rank) => {
    const reward = feature.rankRewards.find((r) => r.rank === rank);
    const card = reward?.cardId ? queued.cards[reward.cardId] : undefined;
    return {
      rank,
      name: card?.name ?? null,
      credits: reward?.credits ?? 0,
      image: card?.image ?? null,
    };
  });
  const settings = await packs.challengeSettings();
  const { jpeg, missing } = await renderChallengePoster(
    {
      headline,
      weekLabel: posterWeekLabel(
        queued.startsAt,
        new Date(queued.startsAt.getTime() + WEEK_MS),
        settings.timezone,
      ),
      stages: queued.stages.map((s) => ({
        stage: s.stageNumber,
        unlocked: false,
      })),
      featureStage: feature.stageNumber,
      podium: podium.map(({ rank, name, credits }) => ({
        rank,
        name,
        credits,
      })),
      leaders: [],
      siteHost: 'polycards.gg/leaderboard',
    },
    new Map(podium.map((p) => [p.rank, p.image])),
  );
  res.setHeader('Content-Type', 'image/jpeg');
  if (missing.length) res.setHeader('x-poster-missing-art', missing.join(','));
  res.status(200).send(jpeg);
}
