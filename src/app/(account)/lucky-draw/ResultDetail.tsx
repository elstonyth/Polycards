'use client';

import { useRef } from 'react';
import { X } from 'lucide-react';
import { Pill } from '@/components/ui/pill';
import { useModalA11y } from '@/lib/use-modal-a11y';
import { cn } from '@/lib/utils';
import { num, rmAuto } from '@/lib/format';
import { ticketRanges, winnerIndex } from '@/lib/lucky-draw';
import type { LuckyDrawResultDetail } from '@/lib/data/schemas';
import { mytWhen, PersonChip, PrizeArt } from './PrizeCard';

const range = (r: { start: number; end: number }) =>
  r.start === r.end ? `#${r.start}` : `#${r.start}–#${r.end}`;

function Code({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] font-semibold tracking-wide text-neutral-400 uppercase">
        {label}
      </p>
      <code className="mt-1 block rounded-lg bg-neutral-950 px-2 py-1.5 font-mono text-[11px] break-all text-neutral-300">
        {value}
      </code>
    </div>
  );
}

/**
 * One drawn prize (spec §7, §9): the winner, the revealed seed beside the hash
 * shown before the draw, the frozen entry list in draw order with each
 * entrant's ticket numbers, and how to check it all by hand.
 */
export function ResultDetail({
  detail,
  onClose,
  onReplay,
}: {
  detail: LuckyDrawResultDetail;
  onClose: () => void;
  onReplay: (detail: LuckyDrawResultDetail) => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useModalA11y(panelRef, true, onClose);
  const { result, entries, ticket_index } = detail;
  const ranges = ticketRanges(entries);
  const win = winnerIndex(entries, ticket_index);

  return (
    <div
      className="glass-stage fixed inset-0 z-[60] flex items-end justify-center bg-black/40 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="result-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="glass-panel max-h-[90dvh] w-full overflow-y-auto rounded-t-2xl border p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] outline-none sm:max-w-lg sm:rounded-2xl"
      >
        <div className="flex items-start gap-3">
          <span className="relative aspect-[5/7] w-16 shrink-0 overflow-hidden rounded-lg border border-white/10 bg-white/[0.04] p-1">
            <span className="relative block h-full w-full">
              <PrizeArt src={result.image} />
            </span>
          </span>
          <div className="min-w-0 flex-1">
            <h2
              id="result-title"
              className="text-base leading-snug font-semibold text-white"
            >
              {result.title}
            </h2>
            <p className="font-heading mt-0.5 text-lg text-chase tabular-nums">
              {rmAuto(result.value_myr)}
            </p>
            <p className="mt-1 text-xs text-neutral-400">
              Drawn {mytWhen(result.drawn_at)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mt-2 -mr-2 flex h-11 w-11 items-center justify-center rounded-lg text-white/60 transition-colors hover:bg-white/10 hover:text-white"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>

        <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.03] p-3">
          {result.winner && win >= 0 ? (
            <>
              <p className="text-[11px] font-semibold tracking-wide text-neutral-400 uppercase">
                Winner
              </p>
              <PersonChip
                person={result.winner}
                size={36}
                className="mt-1.5 text-base font-semibold text-white"
              />
              <p className="mt-1.5 text-sm text-neutral-400 tabular-nums">
                {num(result.winner_tickets)} of {num(result.total_tickets)}{' '}
                tickets · {num(result.entrant_count)}{' '}
                {result.entrant_count === 1 ? 'entrant' : 'entrants'} · winning
                ticket #{ticket_index}
              </p>
              <Pill
                variant="secondary"
                size="sm"
                className="mt-3"
                onClick={() => onReplay(detail)}
              >
                Watch the draw
              </Pill>
            </>
          ) : (
            <p className="text-sm text-neutral-300">
              No entries — nothing was drawn.
            </p>
          )}
        </div>

        <section className="mt-5 space-y-3">
          <h3 className="text-sm font-semibold text-white">Fair draw</h3>
          <Code label="Hash shown before the draw" value={result.seed_hash} />
          <Code label="Seed" value={result.seed} />
          <p className="text-xs leading-relaxed text-neutral-400">
            <span className="font-semibold text-neutral-300">
              How to check.
            </span>{' '}
            The SHA-256 of the seed (the 64-character text above, as UTF-8) must
            equal the hash shown before the draw. The winning ticket is
            HMAC-SHA256 with that 64-character hex seed string as the key
            (UTF-8) and this prize&rsquo;s id as the message (
            <code className="font-mono break-all text-neutral-300">
              {result.prize_id}
            </code>
            ), read as a 256-bit number, modulo the total tickets (
            {num(result.total_tickets)}). Count through the entry list below in
            the order shown — each entrant&rsquo;s tickets are a range, starting
            at #0 — and the range holding that number is the winner.
          </p>
        </section>

        <section className="mt-5">
          <h3 className="text-sm font-semibold text-white">
            Entries{' '}
            <span className="font-normal text-neutral-400">
              (in draw order)
            </span>
          </h3>
          {entries.length === 0 ? (
            <p className="mt-2 text-sm text-neutral-400">No entries.</p>
          ) : (
            <ol className="mt-2 overflow-hidden rounded-xl border border-white/10">
              {entries.map((e, i) => (
                <li
                  key={i}
                  className={cn(
                    'flex items-center gap-2 px-3 py-2 text-sm text-neutral-200',
                    i > 0 && 'border-t border-white/5',
                    i === win && 'bg-white/[0.06]',
                  )}
                >
                  <PersonChip person={e.person} className="flex-1" />
                  {i === win && (
                    <span className="shrink-0 rounded-full bg-neutral-50 px-2 py-0.5 text-[10px] font-bold text-neutral-950 uppercase">
                      Winner
                    </span>
                  )}
                  <span className="shrink-0 text-right text-xs text-neutral-400 tabular-nums">
                    {num(e.tickets)}
                    {ranges[i] && ` · ${range(ranges[i])}`}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </div>
  );
}
