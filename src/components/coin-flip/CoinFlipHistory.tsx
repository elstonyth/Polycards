'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { getCoinFlipHistory } from '@/lib/actions/coin-flip';
import type { CoinFlipHistory as History } from '@/lib/coin-flip';
import { rm } from '@/lib/format';
import { Pill } from '@/components/ui/pill';

export function CoinFlipHistory({ refresh = 0 }: { refresh?: number }) {
  const [page, setPage] = useState(1);
  const [history, setHistory] = useState<History | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    getCoinFlipHistory(page)
      .then((result) => {
        if (!active) return;
        if (result.ok) {
          setHistory(result);
          setError('');
        } else setError('Could not load coin flip history.');
      })
      .catch(() => {
        if (active) setError('Could not load coin flip history.');
      });
    return () => {
      active = false;
    };
  }, [page, refresh]);
  return (
    <section
      aria-label="Coin flip history"
      className="mt-10 border-t border-white/10 pt-6"
    >
      <h2 className="font-display text-xl font-bold">Coin flip history</h2>
      <p className="mt-1 text-sm text-neutral-400">
        Every win and forfeited card.
      </p>
      {error ? (
        <p role="alert" className="mt-4 text-sm text-red-300">
          {error}
        </p>
      ) : !history ? (
        <p role="status" className="py-6 text-sm text-neutral-400">
          Loading flips…
        </p>
      ) : history.rounds.length === 0 ? (
        <p className="py-6 text-sm text-neutral-400">
          Your completed flips will appear here.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-white/10">
          {history.rounds.map((round) => (
            <li key={round.id}>
              <Link
                href={`/vault/coin-flip?round=${encodeURIComponent(round.id)}`}
                className="flex min-h-20 items-center justify-between gap-4 py-4 outline-none focus-visible:ring-2 focus-visible:ring-white/60"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">
                    {round.card.name}
                  </span>
                  <span className="mt-1 block text-xs text-neutral-400">
                    {round.settled_at
                      ? new Date(round.settled_at).toLocaleString('en-MY', {
                          timeZone: 'Asia/Kuala_Lumpur',
                        })
                      : ''}
                  </span>
                </span>
                <span className="shrink-0 text-right text-sm">
                  <span
                    className={
                      round.status === 'won' ? 'text-buyback-fg' : 'text-white'
                    }
                  >
                    {round.status === 'won'
                      ? `+${rm(round.win_amount)}`
                      : 'Card forfeited'}
                  </span>
                  <span className="mt-1 block text-xs text-neutral-400">
                    {round.status === 'won'
                      ? 'Card kept'
                      : rm(round.stake_amount)}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {history && history.count > 10 && (
        <div className="mt-3 flex items-center justify-between gap-3">
          <Pill
            variant="secondary"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            Previous
          </Pill>
          <span className="text-sm text-neutral-400">
            {page} / {Math.ceil(history.count / 10)}
          </span>
          <Pill
            variant="secondary"
            disabled={page * 10 >= history.count}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Pill>
        </div>
      )}
    </section>
  );
}
