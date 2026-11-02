// How a task reads on the board and in the planner: a ticket with a goal, a
// perforation and what it pays, plus the seven-day check-in track.
import { Badge, Text, clx } from '@medusajs/ui';
import {
  Calendar,
  CreditCard,
  Plus,
  Sparkles,
  Star,
  Trophy,
} from '@medusajs/icons';
import type { ReactNode } from 'react';
import type { AdminTaskDefinition } from '../../lib/queries';
import { resolveImageUrl } from '../../lib/image-url';
import { goalAmount, shortPack } from './task-board';
import { labelsOf } from './task-draft';
import { goalWords, rewardPictureOf, rewardWords } from './task-words';

const money = (n: number): string =>
  `RM ${n.toLocaleString('en-MY', { maximumFractionDigits: 2 })}`;

/** The silver ticket art vanishes on a white surface. */
export const RewardArt = ({ t }: { t: AdminTaskDefinition }) => {
  const picture = rewardPictureOf(t);
  return (
    <span
      className={clx(
        'relative h-12 w-9 overflow-hidden rounded-lg max-sm:hidden',
        t.reward.type === 'tickets' && 'bg-[#141416]',
      )}
    >
      {picture && (
        <img
          src={resolveImageUrl(picture)}
          alt=""
          loading="lazy"
          className={clx(
            'absolute inset-0 h-full w-full object-contain',
            t.reward.type === 'tickets' ? 'p-[3px]' : 'p-px',
          )}
        />
      )}
    </span>
  );
};

export const GoalArt = ({ t }: { t: AdminTaskDefinition }) => {
  const type = t.requirement.type;
  const image = t.view?.goal_image ?? null;
  return (
    <span className="bg-ui-bg-subtle shadow-borders-base text-ui-fg-subtle relative grid h-14 w-11 shrink-0 place-items-center overflow-hidden rounded-lg">
      {image ? (
        <img
          src={resolveImageUrl(image)}
          alt=""
          loading="lazy"
          className={clx(
            'absolute inset-0 h-full w-full object-contain',
            type === 'vault_pixel_count'
              ? 'p-[5px] [image-rendering:pixelated]'
              : 'p-1',
          )}
        />
      ) : type === 'checkin_days' ? (
        <Calendar />
      ) : type === 'topup_myr' ? (
        <CreditCard />
      ) : type === 'reach_level' ? (
        <Trophy />
      ) : type === 'vault_count' ? (
        <Star />
      ) : (
        <Sparkles />
      )}
    </span>
  );
};

export const Perforation = () => (
  <span
    aria-hidden
    className="border-ui-border-strong h-9 self-center border-l border-dashed"
  />
);

export const GoalLine = ({ t }: { t: AdminTaskDefinition }) => {
  const g = goalWords(t);
  return (
    <span>
      {g.verb} <span className="font-semibold tabular-nums">{g.amount}</span>
      {g.what && ` ${g.what}`}
    </span>
  );
};

export const TaskRow = ({
  t,
  flagged,
  actions,
  onOpen,
}: {
  t: AdminTaskDefinition;
  /** The stored name parts from the rule. */
  flagged: boolean;
  actions?: ReactNode;
  /** Absent = a past week, read-only. */
  onOpen?: () => void;
}) => {
  const anyPack = t.requirement.type === 'rip_count' && !t.requirement.pack_id;
  const reward = rewardWords(t);
  const body = (
    <>
      <GoalArt t={t} />
      <span className="min-w-0 leading-snug">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <Text as="span" size="small" leading="compact">
            <GoalLine t={t} />
          </Text>
          {flagged ? (
            <Badge size="2xsmall" color="orange">
              Check
            </Badge>
          ) : (
            anyPack && (
              <Badge size="2xsmall" color="orange">
                Any pack
              </Badge>
            )
          )}
          {!t.active && (
            <Badge size="2xsmall" color="grey">
              Retired
            </Badge>
          )}
        </span>
        {flagged ? (
          <Text as="span" size="xsmall" className="text-ui-fg-muted block">
            Named “{t.title}”
          </Text>
        ) : (
          (t.claims ?? 0) > 0 && (
            <Text
              as="span"
              size="xsmall"
              className="text-ui-fg-muted block tabular-nums"
            >
              {(t.claims ?? 0).toLocaleString('en-MY')} claimed
            </Text>
          )
        )}
      </span>
      <Perforation />
      <RewardArt t={t} />
      <span className="min-w-0 leading-snug">
        <Text as="span" size="small" leading="compact" className="block">
          {reward.main}
        </Text>
        {reward.sub && (
          <Text
            as="span"
            size="xsmall"
            className="text-ui-fg-muted block tabular-nums"
          >
            {reward.sub}
          </Text>
        )}
      </span>
    </>
  );
  const grid =
    'grid min-h-16 min-w-0 flex-1 grid-cols-[44px_minmax(0,1fr)_1px_minmax(84px,38%)] items-center gap-x-3 py-2 pr-1.5 pl-3 text-left sm:grid-cols-[44px_minmax(0,1fr)_1px_36px_minmax(92px,0.72fr)]';
  return (
    <li className="hover:bg-ui-bg-base-hover flex items-center rounded-lg transition-colors">
      {onOpen ? (
        <button type="button" onClick={onOpen} className={grid}>
          {body}
        </button>
      ) : (
        <div className={grid}>{body}</div>
      )}
      <span className="mr-1.5 w-8 shrink-0">{actions}</span>
    </li>
  );
};

const DayValue = ({ rows }: { rows: AdminTaskDefinition[] }) => {
  const first = rows[0];
  if (rows.length > 1) {
    const tickets = rows.reduce(
      (sum, r) => sum + (r.reward.type === 'tickets' ? (r.tickets ?? 0) : 0),
      0,
    );
    return (
      <span className="block text-[13px] leading-tight font-semibold">
        {tickets > 0 ? `${tickets} tickets` : `${rows.length} rewards`}
        {tickets > 0 && (
          <span className="block text-xs font-normal text-neutral-300">
            {rows.length} rewards
          </span>
        )}
      </span>
    );
  }
  const type = first.reward.type;
  const main =
    type === 'tickets'
      ? `×${first.tickets ?? 0}`
      : type === 'credit'
        ? money(Number(first.reward.amount_myr ?? 0))
        : shortPack(first.view?.reward_name ?? labelsOf(first).reward);
  const sub =
    type === 'tickets'
      ? 'tickets'
      : type === 'credit'
        ? 'credit'
        : type === 'pack'
          ? 'Free rip'
          : null;
  return (
    <span className="block text-[13px] leading-tight font-semibold tabular-nums">
      {main}
      {sub && (
        <span className="block text-xs font-normal text-neutral-300">
          {sub}
        </span>
      )}
    </span>
  );
};

/**
 * The week as the player sees it. Drawn dark in either theme, as /task draws it.
 * Two rewards on one day, or a day with none, are plain to see here.
 */
export const CheckInTrack = ({
  rows,
  onOpenDay,
  onAddDay,
}: {
  rows: AdminTaskDefinition[];
  onOpenDay?: (t: AdminTaskDefinition) => void;
  onAddDay?: (day: number) => void;
}) => (
  <ol className="grid grid-cols-4 gap-2 sm:grid-cols-7">
    {[1, 2, 3, 4, 5, 6, 7].map((day) => {
      const here = rows.filter(
        (r) =>
          r.requirement.type === 'checkin_days' &&
          goalAmount(r.requirement) === day,
      );
      if (here.length === 0) {
        const inner = (
          <>
            <Text size="xsmall" weight="plus" className="text-ui-fg-subtle">
              Day {day}
            </Text>
            <span className="grid h-14 place-items-center">
              {onAddDay && <Plus />}
            </span>
            <Text size="xsmall" className="text-ui-fg-muted">
              Nothing yet
            </Text>
          </>
        );
        const empty =
          'border-ui-border-strong text-ui-fg-muted flex min-h-[138px] w-full flex-col items-center gap-y-1.5 rounded-lg border border-dashed px-1 py-2.5 text-center';
        return (
          <li key={day}>
            {onAddDay ? (
              <button
                type="button"
                onClick={() => onAddDay(day)}
                className={clx(
                  empty,
                  'hover:bg-ui-bg-base-hover transition-colors',
                )}
              >
                {inner}
              </button>
            ) : (
              <div className={empty}>{inner}</div>
            )}
          </li>
        );
      }
      const inner = (
        <>
          <span className="text-xs font-medium text-neutral-300">
            Day {day}
          </span>
          <span className="flex h-14 items-center justify-center">
            {here.map((r, i) => {
              const picture = rewardPictureOf(r);
              return (
                picture && (
                  <img
                    key={r.id}
                    src={resolveImageUrl(picture)}
                    alt=""
                    loading="lazy"
                    className={clx(
                      'object-contain',
                      here.length > 1 ? 'h-12 w-11' : 'h-14 w-14',
                      i > 0 && '-ml-4',
                    )}
                  />
                )
              );
            })}
          </span>
          <DayValue rows={here} />
        </>
      );
      const tile = clx(
        'flex min-h-[138px] w-full flex-col items-center gap-y-1.5 rounded-lg bg-[#0f0f10] px-1 py-2.5 text-center text-white',
        here.length > 1
          ? 'shadow-[inset_0_0_0_2px_#ffb020]'
          : 'shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)]',
      );
      return (
        <li key={day}>
          {onOpenDay ? (
            <button
              type="button"
              aria-label={`Day ${day}`}
              onClick={() => onOpenDay(here[0])}
              className={clx(tile, 'transition-colors hover:bg-[#1c1c1f]')}
            >
              {inner}
            </button>
          ) : (
            <div className={tile}>{inner}</div>
          )}
        </li>
      );
    })}
  </ol>
);
