/**
 * The CSS tiles as the spin kit's painter poses them: the pack list (a
 * tile's sold-out state from its accessible name, which ends ", sold out" as
 * `StageTile` writes it, and the capsule flag from the row on show at the
 * same index), the spin context per pack, and the pose with a capsule's lean
 * limits, so the flat tiles draw as the canvas does. Pure.
 */
import type {
  ComposeCtx,
  Pose,
  SpinPanel,
  StageLayout,
  StageState,
} from './contract';
import { CAPSULE_LIMITS, SLEEVE_TILE, capsulePose } from './stage-capsule-lean';
import { poseAt } from './stage-pose';
import { composePose } from './stage-pose-compose';
import { LEAN } from './stage-spin-math';
import { lineupOpacity, lineupPose } from './stage-spin';

export type TilePack = { soldOut: boolean; ticket: boolean };

/**
 * The tiles' packs, from the row on show; a tile with no row entry poses as
 * `SLEEVE_TILE`, except that its name still says whether it is sold out.
 */
export function rowTilePacks(
  labels: readonly (string | null)[],
  packs: readonly TilePack[] | undefined,
): TilePack[] {
  return labels.map((label, i) => {
    const entry = packs?.[i];
    if (entry) return { soldOut: entry.soldOut, ticket: entry.ticket };
    return {
      soldOut: !!label?.endsWith(', sold out'),
      ticket: SLEEVE_TILE.ticket,
    };
  });
}

/** The spin context a tile is posed with (a capsule leans as a capsule). */
export function tileSpinCtx(
  count: number,
  pack: Readonly<TilePack>,
  exit: number,
  panel: SpinPanel,
): ComposeCtx {
  return {
    spin: {
      count,
      turn: 0,
      lean: pack.ticket ? CAPSULE_LIMITS.yaw : LEAN,
      spinPose: lineupPose,
      soldOut: pack.soldOut,
      exit,
      panel,
      capsule: pack.ticket,
    },
    spinOpacity: lineupOpacity,
    compose: composePose,
  };
}

/** A tile's pose: the composed pose, a capsule's yaw and pitch held in its limits. */
export function tilePose(
  state: Readonly<StageState>,
  i: number,
  l: Readonly<StageLayout>,
  desktop: boolean,
  pack: Readonly<TilePack>,
  ctx: ComposeCtx,
): Pose {
  return capsulePose(
    poseAt(state, i, l, desktop, pack.soldOut, ctx),
    pack.ticket,
  );
}
