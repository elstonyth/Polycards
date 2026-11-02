// What a task looks like on /task: the storefront's ticket row (TaskRow in
// TaskHubClient.tsx) or, for a weekly check-in, its tile on the track. Drawn with
// the storefront's own dark surface in either admin theme. It reads only the
// draft's rule, so what staff see here is what the rule pays.
import { CreditCard, LockClosedSolid, Sparkles } from '@medusajs/icons';
import { resolveImageUrl } from '../../lib/image-url';
import { taskName } from './task-board';
import { ANY, countApplies, draftParts, type Draft } from './task-draft';
import { rewardPicture } from './task-words';

const money = (n: number): string =>
  `RM ${n.toLocaleString('en-MY', { maximumFractionDigits: 2 })}`;

const prizeName = (d: Draft): string | null => {
  const n = Number(d.tickets);
  if (d.rewardType === 'tickets')
    return n >= 1 ? `${n} Lucky Draw tickets` : null;
  if (d.rewardType === 'credit')
    return Number(d.rewardValue) > 0
      ? `${money(Number(d.rewardValue))} bonus credit`
      : null;
  if (d.rewardType === 'pack')
    return d.prize.name ? `Free rip · ${d.prize.name}` : null;
  return d.prize.name;
};

const VERB: Record<string, string> = {
  rip_count: 'RIP',
  vault_pixel_count: 'PULL',
  vault_count: 'COLLECT',
  reach_level: 'REACH',
  checkin_days: 'CHECK IN',
  topup_myr: 'TOP UP',
};

const ReadyTile = ({ d }: { d: Draft }) => {
  const picture = rewardPicture(d);
  const tickets = Number(d.tickets);
  const name = prizeName(d);
  const day = Number(d.reqN);
  return (
    <div className="flex items-start gap-x-3">
      <div className="relative flex h-40 w-28 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-neutral-950">
        <span className="absolute top-2 left-2 text-[11px] font-semibold text-neutral-300">
          {day > 0 ? `${day} ${day === 1 ? 'DAY' : 'DAYS'}` : 'DAY'}
        </span>
        {picture ? (
          <img
            src={resolveImageUrl(picture)}
            alt=""
            className="h-24 w-24 object-contain"
          />
        ) : (
          <span className="h-20 w-16 rounded-md border border-dashed border-white/20" />
        )}
        {d.rewardType === 'tickets' && tickets >= 1 && (
          <span className="pc-nekst absolute -bottom-2 left-1/2 -translate-x-1/2 rounded-full border border-white/10 bg-neutral-950 px-2 py-px text-xs whitespace-nowrap text-[#ffb020]">
            ×{tickets}
          </span>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-y-1 pt-1">
        <span className="pc-nekst text-sm text-white">CHECK-IN TRACK</span>
        <span className="text-xs text-neutral-300">
          {name ?? 'The reward shows here.'}
        </span>
      </div>
    </div>
  );
};

const TicketRow = ({ d }: { d: Draft }) => {
  const n = countApplies(d) ? Number(d.reqN) : 1;
  const hasN = n > 0;
  const verb = VERB[d.reqType];
  const topup = d.reqType === 'topup_myr';
  const amount = !hasN
    ? ''
    : d.reqType === 'reach_level'
      ? `LV ${n}`
      : topup
        ? money(n)
        : `×${n}`;
  const anyGoal =
    (d.reqType === 'rip_count' && d.reqPack === ANY) ||
    (d.reqType === 'vault_pixel_count' && d.reqPixel === ANY);
  const picture = rewardPicture(d);
  const name = prizeName(d);
  const title =
    d.reqType && d.rewardType && hasN
      ? taskName(draftParts(d))
      : 'The name writes itself from the rule.';
  const pips = !topup && hasN && n <= 10 ? n : 1;

  return (
    <div className="relative isolate flex min-h-[150px] [--stub:6.5rem]">
      <span
        aria-hidden
        className="pc-ticket-cut absolute inset-0 -z-10 rounded-xl border border-white/10"
      />
      <div className="flex min-w-0 flex-1 flex-col justify-center py-3 pr-2.5 pl-3">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span
            className={`pc-nekst text-[17px] leading-none ${verb ? 'text-white' : 'text-neutral-500'}`}
          >
            {verb ?? 'GOAL'}
          </span>
          {verb && verb !== 'CHECK IN' && verb !== 'REACH' && (
            <span className="relative grid h-[46px] w-[38px] shrink-0 place-items-center rounded-lg border border-white/10 bg-white/[0.04] text-neutral-300">
              {d.goal.image ? (
                <img
                  src={resolveImageUrl(d.goal.image)}
                  alt=""
                  className={`absolute inset-0 h-full w-full object-contain ${
                    d.reqType === 'vault_pixel_count'
                      ? 'p-1 [image-rendering:pixelated]'
                      : 'p-0.5'
                  }`}
                />
              ) : topup ? (
                <CreditCard />
              ) : anyGoal ? (
                <Sparkles />
              ) : null}
            </span>
          )}
          <span className="pc-nekst text-[23px] leading-none whitespace-nowrap text-white tabular-nums">
            {amount}
          </span>
        </div>
        <p
          className={`mt-2 text-xs leading-snug ${
            d.reqType && d.rewardType && hasN
              ? 'text-neutral-300'
              : 'text-neutral-500'
          }`}
        >
          {title}
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
      </div>
      <span
        aria-hidden
        className="my-3 border-l border-dashed border-white/15"
      />
      <div className="flex w-[var(--stub)] shrink-0 flex-col items-center justify-center gap-y-1.5 px-1.5 py-2.5 text-center">
        {picture ? (
          <img
            src={resolveImageUrl(picture)}
            alt=""
            className="h-[60px] w-[52px] object-contain"
          />
        ) : (
          <span className="h-[60px] w-[52px] rounded-lg border border-dashed border-white/20" />
        )}
        <p
          className={`text-[11px] leading-tight text-balance ${name ? 'text-neutral-200' : 'text-neutral-500'}`}
        >
          {name ?? 'Reward'}
        </p>
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
      <ReadyTile d={draft} />
    ) : (
      <TicketRow d={draft} />
    )}
  </div>
);
