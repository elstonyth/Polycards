// What a task looks like on /task: the storefront's ticket row (TaskRow in
// TaskHubClient.tsx) or, for a weekly check-in, its slot on the track. Drawn with
// the storefront's own dark surface in either admin theme. It reads only the
// draft's rule, so what staff see here is what the rule pays.
import {
  Calendar,
  CreditCard,
  LockClosedSolid,
  Sparkles,
  Star,
  Trophy,
} from '@medusajs/icons';
import { resolveImageUrl } from '../../lib/image-url';
import { money, taskName } from './task-board';
import {
  ANY,
  countApplies,
  draftMissing,
  draftParts,
  type Draft,
} from './task-draft';
import { rewardPicture } from './task-words';

const GOAL: Record<string, { verb: string; one: string; many: string }> = {
  rip_count: { verb: 'RIP', one: 'rip', many: 'rips' },
  vault_pixel_count: { verb: 'PULL', one: 'pull', many: 'pulls' },
  vault_count: { verb: 'COLLECT', one: 'card', many: 'cards' },
  reach_level: { verb: 'REACH', one: 'level', many: 'levels' },
  checkin_days: { verb: 'CHECK IN', one: 'check-in', many: 'check-ins' },
  topup_myr: { verb: 'TOP UP', one: '', many: '' },
};

const ticketsText = (n: number): string =>
  `${n} Lucky Draw ${n === 1 ? 'ticket' : 'tickets'}`;

/** The prize's name under its picture on the ticket, as /task words it. */
const stubName = (d: Draft): string | null => {
  if (d.rewardType === 'tickets')
    return Number(d.tickets) >= 1 ? 'Lucky Draw tickets' : null;
  if (d.rewardType === 'credit')
    return Number(d.rewardValue) > 0 ? 'Bonus credit' : null;
  if (d.rewardType === 'pack')
    return d.prize.name ? `Free rip · ${d.prize.name}` : null;
  if (!d.prize.name) return null;
  return d.prize.grade ? `${d.prize.name} · ${d.prize.grade}` : d.prize.name;
};

/** The worth badge on the prize's picture. */
const worthOf = (d: Draft): number | null =>
  d.rewardType === 'credit'
    ? Number(d.rewardValue) || null
    : d.rewardType === 'tickets'
      ? null
      : d.prize.value;

/** A check-in slot's prize in words, as the track says it. */
const slotWords = (d: Draft): string | null => {
  const tickets = Number(d.tickets) || 0;
  const onTop = tickets > 0 ? ` + ${ticketsText(tickets)}` : '';
  if (d.rewardType === 'tickets')
    return tickets >= 1 ? ticketsText(tickets) : null;
  if (d.rewardType === 'credit')
    return Number(d.rewardValue) > 0
      ? `${money(Number(d.rewardValue))} bonus credit${onTop}`
      : null;
  const name = stubName(d);
  if (!name) return null;
  return `${name}${d.prize.value ? ` (${money(d.prize.value)})` : ''}${onTop}`;
};

const CheckInSlot = ({ d }: { d: Draft }) => {
  const picture = rewardPicture(d);
  const words = slotWords(d);
  const day = Number(d.reqN);
  return (
    <div className="flex items-start gap-x-3">
      <div className="relative flex h-36 w-24 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-neutral-950">
        <span className="absolute top-1.5 left-2 text-[10px] font-semibold text-neutral-400 tabular-nums">
          {day > 0 ? day : ''}
        </span>
        {picture ? (
          <img
            src={resolveImageUrl(picture)}
            alt=""
            className="h-[72%] w-[88%] object-contain"
          />
        ) : (
          <span className="h-20 w-16 rounded-md border border-dashed border-white/20" />
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-y-1 pt-1">
        <span className="pc-nekst text-sm text-white">
          {day > 0 ? `DAY ${day}` : 'CHECK-IN TRACK'}
        </span>
        <span className="text-xs text-neutral-300">
          {words ?? 'The reward shows here.'}
        </span>
      </div>
    </div>
  );
};

const GoalIcon = ({ d }: { d: Draft }) => {
  switch (d.reqType) {
    case 'checkin_days':
      return <Calendar />;
    case 'topup_myr':
      return <CreditCard />;
    case 'reach_level':
      return <Trophy />;
    case 'rip_count':
      return <Sparkles />;
    default:
      return <Star />;
  }
};

const TicketRow = ({ d }: { d: Draft }) => {
  const n = countApplies(d) ? Number(d.reqN) : 1;
  const hasN = n > 0;
  const goal = GOAL[d.reqType];
  const topup = d.reqType === 'topup_myr';
  const amount = !hasN
    ? ''
    : d.reqType === 'reach_level'
      ? `LV ${n}`
      : topup
        ? money(n)
        : `×${n}`;
  const named =
    (d.reqType === 'rip_count' && d.reqPack !== ANY && d.reqPack !== '') ||
    (d.reqType === 'vault_pixel_count' &&
      d.reqPixel !== ANY &&
      d.reqPixel !== '');
  const picture = rewardPicture(d);
  const name = stubName(d);
  const worth = worthOf(d);
  const tickets = Number(d.tickets) || 0;
  const ready = draftMissing(d).length === 0;
  const pips = !topup && hasN && n <= 10 ? n : 1;
  const status = !hasN
    ? ''
    : topup
      ? `Top up ${money(n)} more`
      : goal
        ? `${n} more ${n === 1 ? goal.one : goal.many} to go`
        : '';

  return (
    <div className="relative isolate flex min-h-[150px] [--stub:6.5rem]">
      <span
        aria-hidden
        className="pc-ticket-cut absolute inset-0 -z-10 rounded-xl border border-white/10"
      />
      <div className="flex min-w-0 flex-1 flex-col justify-center py-3 pr-2.5 pl-3">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span
            className={`pc-nekst text-[17px] leading-none ${goal ? 'text-white' : 'text-neutral-500'}`}
          >
            {goal?.verb ?? 'GOAL'}
          </span>
          {goal && (
            <span className="relative grid h-[46px] w-[38px] shrink-0 place-items-center rounded-lg border border-white/10 bg-white/[0.04] text-neutral-300">
              {d.goal.image && named ? (
                <img
                  src={resolveImageUrl(d.goal.image)}
                  alt=""
                  className={`absolute inset-0 h-full w-full object-contain ${
                    d.reqType === 'vault_pixel_count'
                      ? 'p-1 [image-rendering:pixelated]'
                      : 'p-0.5'
                  }`}
                />
              ) : (
                <GoalIcon d={d} />
              )}
            </span>
          )}
          <span className="pc-nekst text-[23px] leading-none whitespace-nowrap text-white tabular-nums">
            {amount}
          </span>
        </div>
        <p
          className={`mt-2 text-xs leading-snug ${ready ? 'text-neutral-300' : 'text-neutral-500'}`}
        >
          {ready
            ? taskName(draftParts(d))
            : 'The name writes itself from the rule.'}
        </p>
        <div className="mt-2 flex items-center gap-x-2">
          <div className="flex h-[7px] flex-1 gap-[3px]">
            {Array.from({ length: pips }, (_, i) => (
              <span key={i} className="flex-1 rounded-full bg-white/10" />
            ))}
          </div>
          <span className="pc-nekst text-[13px] leading-none whitespace-nowrap text-white tabular-nums">
            {topup ? 'RM 0' : `0/${hasN ? n : '?'}`}
          </span>
        </div>
        {status && (
          <p className="mt-1.5 text-[11px] leading-snug text-neutral-400">
            {status}
          </p>
        )}
      </div>
      <span
        aria-hidden
        className="my-3 border-l border-dashed border-white/15"
      />
      <div className="flex w-[var(--stub)] shrink-0 flex-col items-center justify-center gap-y-1.5 px-1.5 py-2.5 text-center">
        <span className="relative">
          {picture ? (
            <img
              src={resolveImageUrl(picture)}
              alt=""
              className="h-[60px] w-[52px] object-contain"
            />
          ) : (
            <span className="block h-[60px] w-[52px] rounded-lg border border-dashed border-white/20" />
          )}
          {worth !== null && worth > 0 && (
            <span className="pc-nekst absolute -bottom-2 left-1/2 -translate-x-1/2 rounded-full border border-white/10 bg-neutral-950 px-1.5 py-px text-[10px] leading-tight whitespace-nowrap text-[#ffb020] tabular-nums">
              {money(worth)}
            </span>
          )}
        </span>
        <p
          className={`mt-1 text-[11px] leading-tight text-balance ${name ? 'text-neutral-200' : 'text-neutral-500'}`}
        >
          {name ?? 'Reward'}
        </p>
        {tickets > 0 && (
          <span className="inline-flex items-center rounded-full border border-[#ffb020]/40 px-1.5 py-0.5 text-[11px] font-semibold whitespace-nowrap text-[#ffb020]">
            +{tickets} {tickets === 1 ? 'ticket' : 'tickets'}
          </span>
        )}
        <span className="inline-flex items-center gap-x-1 rounded-full border border-white/10 px-2 py-0.5 text-[11px] font-semibold text-neutral-400">
          <LockClosedSolid className="h-3 w-3" /> Locked
        </span>
      </div>
    </div>
  );
};

export const PlayerPreview = ({ draft }: { draft: Draft }) => (
  <div className="rounded-lg bg-[#0a0a0a] p-3.5 font-sans">
    {draft.kind === 'weekly' && draft.reqType === 'checkin_days' ? (
      <CheckInSlot d={draft} />
    ) : (
      <TicketRow d={draft} />
    )}
  </div>
);
