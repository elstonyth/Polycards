import { rm } from '@/lib/format';

/**
 * Deposit-playthrough bar: how much of the customer's deposits has been spent
 * on packs, and how much is left before withdrawals unlock. Shared by /wallet
 * and the withdrawal form so the two can never tell different stories.
 *
 * Callers render it only when deposited > 0 — a 0/0 bar says nothing. used can
 * exceed deposited once the customer keeps playing, so both bar and caption
 * clamp.
 */
export function PlaythroughProgress({
  deposited,
  used,
  remaining,
}: {
  deposited: number;
  used: number;
  remaining: number;
}) {
  const gateOpen = remaining <= 0;
  const pct = Math.min(100, Math.round((used / deposited) * 100));
  return (
    <>
      <div
        className="mt-4 h-2 overflow-hidden rounded-full bg-neutral-800"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label="Deposit playthrough progress"
      >
        <div
          className={`h-full rounded-full ${gateOpen ? 'bg-buyback' : 'bg-sky-400'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="mt-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm">
        <span className="text-white/70">
          {rm(Math.min(used, deposited))} of {rm(deposited)} spent
        </span>
        <span
          className={gateOpen ? 'text-buyback-fg' : 'font-semibold text-white'}
        >
          {gateOpen ? 'Done' : `${rm(remaining)} left`}
        </span>
      </div>
    </>
  );
}
