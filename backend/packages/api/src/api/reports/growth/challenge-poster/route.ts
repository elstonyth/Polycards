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

// GET /reports/growth/challenge-poster?stage=&leaders=0|1: the running Weekly
// Pulled Value Challenge as a finished poster JPEG for the Growth desk bot to
// post as a draft. Built from the same view as the public Ranks page, with
// each podium prize's official image (modules/packs/challenge-poster.ts).
// stage defaults to the highest unlocked stage; leaders adds the current top 3
// shown names. x-poster-missing-art names podium ranks whose prize card shows
// as a placeholder tile (art that could not be fetched or decoded).
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
