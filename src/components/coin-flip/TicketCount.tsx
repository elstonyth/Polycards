import { TicketArt } from '@/components/TicketArt';
import { coinFlipTicketsLabel } from '@/lib/coin-flip';
import { num } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * A ticket count as the ticket picture × N, not the word (boss, 2026-10-30).
 * Sized in em, so it follows the text around it. Screen readers get "5 tickets".
 * `art={false}` is for a row whose ticket picture already sits beside the count.
 * `lost` dims it: a line-through on a parent does not reach an inline-flex child.
 */
export function TicketCount({
  tickets,
  art = true,
  lost = false,
}: {
  tickets: number;
  art?: boolean;
  lost?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-[0.25em] whitespace-nowrap align-middle">
      {art && (
        <TicketArt
          width={64}
          className={cn('h-[1.25em] w-auto', lost && 'opacity-60 saturate-50')}
        />
      )}
      <span
        aria-hidden
        className={cn(
          lost && 'line-through decoration-neutral-500 decoration-1',
        )}
      >
        × {num(tickets)}
      </span>
      <span className="sr-only">{coinFlipTicketsLabel(tickets)}</span>
    </span>
  );
}
