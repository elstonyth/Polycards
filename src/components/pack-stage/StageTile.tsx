'use client';

import type { CSSProperties, MouseEvent } from 'react';
import Image from 'next/image';
import { IntentLink } from '@/components/IntentLink';
import { cn } from '@/lib/utils';
import { isOptimizableImage } from '@/lib/optimizable-image';
import type { StageLayout, StagePack, StageState } from './contract';
import {
  STAGE_REACH,
  labelIntro,
  poseAt,
  restState,
  slotOpacity,
  stageSpring,
} from './stage-pose';
import styles from './pack-stage.module.css';

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const n = (v: number) => String(Math.round(v * 10000) / 10000);

/**
 * A tile's pose as CSS custom properties, for phones (--m-*) and desktop
 * (--d-*). Written into the server HTML (at rest) and then per frame by
 * StageTrack, from the same `poseAt` and the same state (track, the
 * provider's intro / swap / pointer) the 3D layer draws with.
 *
 * The layout is in UNIT terms: `poseAt` is linear in it (x with `step`, y and z
 * with `artH`), so with step = artH = 1 its numbers are steps and art heights
 * and the CSS multiplies them back by the stage's own --step and --art-h.
 * `cyArt` is the art centre's height in the host, in art heights (it sets how
 * far the float-in drops); 0 at rest is exact.
 */
export function tileVars(
  index: number,
  state: StageState,
  soldOut: boolean,
  cyArt = 0,
): Record<string, string> {
  const layout: StageLayout = { cx: 0, cy: cyArt, step: 1, artH: 1 };
  const d = index - state.track;
  const a = Math.abs(d);
  // The category switch fades the sinking packs out and the rising ones in.
  const swapFade = 1 - stageSpring(clamp01(state.swap));
  const label = labelIntro(state.intro, d) * swapFade;
  const vars: Record<string, string> = {};
  for (const [prefix, desktop] of [
    ['m', false],
    ['d', true],
  ] as const) {
    const pose = poseAt(state, index, layout, desktop, soldOut);
    const reach = desktop ? STAGE_REACH.desktop : STAGE_REACH.phone;
    const op = slotOpacity(d, desktop) * swapFade;
    // Desktop: every visible neighbour carries its name and price; the centred
    // pack's live in the info block. Phones show the info block only.
    const lo = desktop
      ? Math.min(clamp01(a * 2), clamp01(reach + 0.5 - a) * 2) * label
      : 0;
    vars[`--${prefix}-dx`] = n(pose.dx);
    vars[`--${prefix}-dy`] = n(pose.dy);
    vars[`--${prefix}-z`] = n(pose.z);
    vars[`--${prefix}-rx`] = n(pose.rotX);
    vars[`--${prefix}-ry`] = n(pose.rotY);
    vars[`--${prefix}-s`] = n(pose.scale);
    vars[`--${prefix}-dim`] = n(pose.dim);
    vars[`--${prefix}-op`] = n(op);
    vars[`--${prefix}-lo`] = n(clamp01(lo));
    vars[`--${prefix}-pe`] = op > 0.5 ? 'auto' : 'none';
    vars[`--${prefix}-lpe`] = lo > 0.5 ? 'auto' : 'none';
  }
  return vars;
}

/**
 * One pack in the carousel, in the slot markup the 3D layer attaches to (plan
 * section 10): `li[data-stage-tile][data-pack-id][data-index]` holding a
 * `[data-stage-art][data-live]` box with the picture in it. A pack with a 3D
 * set shows its bundled half front as a plain `<img>` (the texture fetch then
 * hits the HTTP cache, and the swap lines up); any other pack its catalogue
 * image through next/image, as the shelf does.
 *
 * In stock, the tile is a link named by its own text (the image is `alt=""`);
 * sold out, it is a plain div, as in the shelf's ladder.
 */
export default function StageTile({
  pack,
  index,
  count,
  start,
  priority,
  eager,
  onFocusTile,
  onClickTile,
}: {
  pack: StagePack;
  index: number;
  count: number;
  /** The track position the server renders at. */
  start: number;
  /** The first centred pack of the first tab: the likely LCP. */
  priority: boolean;
  /** Drawn at the first paint (near the start): not lazy. */
  eager: boolean;
  onFocusTile: (index: number) => void;
  onClickTile: (index: number, event: MouseEvent) => void;
}) {
  const a0 = Math.abs(index - start);
  const style = {
    ...tileVars(index, restState(start), pack.soldOut),
    '--i': String(index),
    // The loader hand-over: centre first, neighbours 90 ms apart.
    '--fade-delay': `${Math.min(a0, 4) * 90}ms`,
  } as CSSProperties;
  const labelDelay = {
    '--fade-delay': `${Math.min(a0, 4) * 90 + 120}ms`,
  } as CSSProperties;

  // A 3D tile's picture is the bundled half front, byte for byte the texture the
  // 3D pack loads (CORS mode included, so both share one HTTP cache entry).
  const picture = pack.art3d ? (
    // eslint-disable-next-line @next/next/no-img-element -- see above
    <img
      src={pack.art3d.frontHalf}
      crossOrigin="anonymous"
      alt=""
      width={Math.round(pack.art3d.width / 2)}
      height={Math.round(pack.art3d.height / 2)}
      draggable={false}
      decoding="async"
      loading={eager ? 'eager' : 'lazy'}
      fetchPriority={priority ? 'high' : undefined}
      className={styles.pic}
    />
  ) : (
    <Image
      src={pack.image}
      alt=""
      width={300}
      height={540}
      draggable={false}
      // Operator-entered art can live on any host; bypass the optimizer for
      // remote art only, as the shelf and the catalogue do.
      unoptimized={!isOptimizableImage(pack.image)}
      priority={priority}
      loading={priority ? undefined : eager ? 'eager' : 'lazy'}
      className={styles.pic}
    />
  );

  const body = (
    <>
      <div data-stage-art="" data-live="0" className={styles.art}>
        <div data-stage-pose="" className={styles.pose}>
          <div data-stage-fade="" className={styles.fade}>
            {pack.ticket ? (
              <div className={styles.sway}>{picture}</div>
            ) : (
              picture
            )}
          </div>
        </div>
      </div>
      <span
        data-stage-label=""
        data-stage-fade=""
        className={cn(styles.label, 'flex flex-col items-center gap-0.5')}
        style={labelDelay}
      >
        <span
          className={cn(
            'max-w-full truncate text-sm font-semibold text-neutral-300',
            pack.soldOut && 'opacity-50',
          )}
        >
          {pack.name}
        </span>
        <span
          className={cn(
            'font-heading text-base tabular-nums text-neutral-400',
            pack.soldOut && 'opacity-50',
          )}
        >
          {pack.priceLabel}
        </span>
        {pack.soldOut && (
          <span className="text-[11px] font-semibold uppercase tracking-wide text-neutral-300">
            Sold out
          </span>
        )}
      </span>
    </>
  );

  const label = `${pack.name}, ${index + 1} of ${count}${pack.soldOut ? ', sold out' : ''}`;

  return (
    <li
      data-stage-tile=""
      data-pack-id={pack.id}
      data-index={index}
      role="group"
      aria-roledescription="slide"
      aria-label={label}
      className={styles.tile}
      style={style}
    >
      {pack.soldOut ? (
        <div
          data-stage-hit=""
          tabIndex={-1}
          className={styles.hit}
          onFocus={() => onFocusTile(index)}
          onClick={(event) => onClickTile(index, event)}
        >
          {body}
        </div>
      ) : (
        <IntentLink
          data-stage-hit=""
          href={pack.href}
          draggable={false}
          className={styles.hit}
          onFocus={() => onFocusTile(index)}
          onClick={(event) => onClickTile(index, event)}
        >
          {body}
        </IntentLink>
      )}
    </li>
  );
}
