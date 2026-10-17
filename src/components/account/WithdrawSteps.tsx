import Link from 'next/link';
import { Check } from 'lucide-react';
import { TopUpButton } from '@/components/account/TopUpButton';
import { pillVariants } from '@/components/ui/pill';
import { rm, rm0 } from '@/lib/format';
import { cn } from '@/lib/utils';
import { stepTwoCopy, type walletSplit } from '@/lib/wallet-split';

/**
 * The withdrawal gate as the customer meets it (spec 2026-10-15 "gate spend
 * first"), shared by /wallet and /bank-withdrawal so the two never tell
 * different stories: the two steps that unlock withdrawals, the money rows,
 * and the three rules. No hooks, so it renders inside the server wallet page
 * and the client withdraw form alike (TopUpButton is its own client island).
 */

/** The "How withdrawals work" rules, said once per page. */
export const WITHDRAW_RULES = [
  'Top up once. After a top-up, withdrawals pause until you use all your money for packs.',
  'Cards you pull are yours: ship them, or sell them back. Sales of cards from packs you pay for, gift packs, and task and challenge rewards become withdrawable once your money for packs is used.',
  'Bonus credit pays for packs and delivery fees, never withdrawals. The welcome pack’s card is for packs. Packs use bonus credit first.',
] as const;

function StepMark({ n, done = false }: { n: number; done?: boolean }) {
  return (
    <span
      aria-hidden
      className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/10 text-[12px] font-bold text-white"
    >
      {done ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : n}
    </span>
  );
}

/** Can't withdraw yet: a real two-step checklist. One white pill at a time —
 *  Top up until step 1 is done, then Open packs. */
export function WithdrawSteps({
  hasTopup,
  depositMinRm,
  available,
  bonus,
  remaining,
  id,
  className,
}: {
  hasTopup: boolean;
  depositMinRm: number;
  available: number;
  bonus: number;
  /** playthrough.remaining — what is still to use on packs. */
  remaining: number;
  id?: string;
  className?: string;
}) {
  const step2 = stepTwoCopy({ hasTopup, available, bonus, remaining });
  return (
    <div id={id} className={className}>
      <ol aria-label="Unlock withdrawals" className="space-y-4">
        <li className="flex gap-3">
          <StepMark n={1} done={hasTopup} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-white">Top up once</p>
            {hasTopup ? (
              <p className="mt-0.5 text-[13px] text-neutral-400">Done</p>
            ) : (
              <>
                <p className="mt-0.5 text-[13px] text-neutral-400">
                  From{' '}
                  <span className="whitespace-nowrap">{rm0(depositMinRm)}</span>
                </p>
                <TopUpButton size="sm" className="mt-2" />
              </>
            )}
          </div>
        </li>
        <li className="flex gap-3">
          <StepMark n={2} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-white">{step2.title}</p>
            {step2.notes.map((note) => (
              <p key={note} className="mt-0.5 text-[13px] text-neutral-400">
                {note}
              </p>
            ))}
            <Link
              href="/slots"
              className={cn(
                pillVariants({
                  variant: hasTopup ? 'primary' : 'secondary',
                  size: 'sm',
                }),
                'mt-2',
              )}
            >
              Open packs
            </Link>
          </div>
        </li>
      </ol>
      <p className="mt-4 text-sm text-neutral-300">
        Then your balance, except bonus credit, can go to your bank.
      </p>
    </div>
  );
}

function Row({
  label,
  value,
  quiet = false,
}: {
  label: string;
  value: number;
  quiet?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className={quiet ? 'text-neutral-400' : 'text-neutral-300'}>
        {label}
      </dt>
      <dd
        className={cn(
          'whitespace-nowrap tabular-nums',
          quiet ? 'text-neutral-300' : 'font-semibold text-white',
        )}
      >
        {rm(value)}
      </dd>
    </div>
  );
}

/** Balance = Withdrawable + Withdrawable later + For packs, as rows. */
export function MoneyRows({
  balance,
  withdrawable,
  split,
}: {
  /** Omitted where the page already shows the balance as its hero figure. */
  balance?: number;
  withdrawable: number;
  split: ReturnType<typeof walletSplit>;
}) {
  return (
    <dl className="space-y-2 text-sm">
      {balance !== undefined && <Row label="Balance" value={balance} />}
      <Row label="Withdrawable" value={withdrawable} />
      {split.lockedCash > 0 && (
        <Row label="Withdrawable later" value={split.lockedCash} />
      )}
      <Row label="For packs" value={split.forPacks} />
      <div className="space-y-1 pl-4 text-[13px]">
        <Row label="Bonus credit · used first" value={split.bonus} quiet />
        <Row label="Still to use on packs" value={split.stillToUse} quiet />
      </div>
    </dl>
  );
}

export function WithdrawRules() {
  return (
    <ol className="space-y-3">
      {WITHDRAW_RULES.map((rule, i) => (
        <li key={rule} className="flex gap-3">
          <StepMark n={i + 1} />
          <p className="text-sm text-neutral-300">{rule}</p>
        </li>
      ))}
    </ol>
  );
}
