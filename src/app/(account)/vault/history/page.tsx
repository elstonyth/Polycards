import type { Metadata } from 'next';
import Link from 'next/link';
import { AccountHeader, Badge, Pager } from '@/components/account/ui';
import { VaultTabs } from '@/components/account/VaultTabs';
import { SlabImage } from '@/components/SlabImage';
import { getPullHistory, type PullHistoryItem } from '@/lib/actions/vault';
import { pullTime, rm } from '@/lib/format';
import { cn } from '@/lib/utils';

export const metadata: Metadata = { title: 'Pull history' };

// What happened to the card since it was pulled. Shipping and delivered link
// to Orders, where the parcel's tracking lives.
const STATUS: Record<
  string,
  { label: string; tone: 'green' | 'sky' | 'neutral'; href?: string }
> = {
  vaulted: { label: 'In vault', tone: 'neutral' },
  bought_back: { label: 'Sold', tone: 'green' },
  delivering: { label: 'Shipping', tone: 'sky', href: '/orders' },
  delivered: { label: 'Delivered', tone: 'neutral', href: '/orders' },
};

// The "Paid" figure: what the card cost out of its open's charge, or how it
// came free. '—' only where the cost is unknown (an open before the charge
// was linked to its cards) — never a made-up RM 0.00.
function paidLabel(p: PullHistoryItem): string {
  if (p.source === 'free') return 'Free pack';
  if (p.source === 'gift') return 'Gift';
  if (p.source === 'reward')
    return p.challengePrize || p.luckyDrawPrize ? 'Prize' : 'Reward';
  return p.paid == null ? '—' : rm(p.paid);
}

function Figure({
  label,
  value,
  money,
}: {
  label: string;
  value: string;
  money?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
        {label}
      </dt>
      <dd
        className={cn(
          'font-heading mt-0.5 whitespace-nowrap text-[13px] tabular-nums sm:text-sm',
          money ? 'text-buyback-fg' : 'text-white',
        )}
      >
        {value}
      </dd>
    </div>
  );
}

// Every card the customer ever pulled — sold and shipped ones included, which
// the vault (held cards only) cannot show — with what it cost, what it was
// worth, and what it sold for. Server-paged (?page=N); no interactivity.
export default async function PullHistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const { page: pageRaw } = await searchParams;
  const page = Number(pageRaw);
  const res = await getPullHistory(Number.isInteger(page) ? page : 1);

  return (
    <>
      <AccountHeader
        title="Vault"
        sub="Every card you’ve pulled: what you paid, and what became of it."
      />
      <VaultTabs current="/vault/history" />
      {!res.ok ? (
        <p className="rounded-xl border border-white/10 bg-white/[0.03] p-4 text-sm text-white/60">
          {res.error}
        </p>
      ) : res.items.length === 0 ? (
        <div className="rounded-2xl border border-white/10 bg-neutral-900 px-6 py-12 text-center">
          <p className="text-sm font-semibold text-white">
            {res.page > 1 ? 'Nothing on this page.' : 'No pulls yet.'}
          </p>
          <p className="mt-1 text-[13px] text-neutral-400">
            {res.page > 1
              ? 'You’ve reached your first pull.'
              : 'Every card you pull lands here, and stays here after you sell or ship it.'}
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {res.items.map((p) => {
            const status = STATUS[p.status];
            const sold = p.soldFor != null;
            return (
              <li
                key={p.pullId}
                className="flex gap-3 rounded-2xl border border-white/10 bg-neutral-900 p-3"
              >
                {p.card.handle ? (
                  <Link
                    href={`/card/${encodeURIComponent(p.card.handle)}`}
                    aria-label={`View ${p.card.name}`}
                    className="w-14 shrink-0 self-start rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-white/40 sm:w-16"
                  >
                    <SlabImage
                      card={p.card}
                      alt=""
                      frameVariant={p.challengePrize ? 'prism' : undefined}
                      sizes="64px"
                      glowScale={0.5}
                      className="w-full"
                    />
                  </Link>
                ) : (
                  // A card since removed from the catalogue: no art, no page.
                  <span
                    aria-hidden
                    className="aspect-[16/27] w-14 shrink-0 self-start rounded-lg border border-white/10 bg-white/[0.04] sm:w-16"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <p
                      className="line-clamp-2 text-sm font-semibold leading-snug text-white"
                      title={p.card.name}
                    >
                      {p.card.name}
                    </p>
                    {status &&
                      (status.href ? (
                        <Link
                          href={status.href}
                          aria-label={`${status.label} — see your orders`}
                          className="shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-white/40"
                        >
                          <Badge tone={status.tone}>{status.label} ›</Badge>
                        </Link>
                      ) : (
                        <span className="shrink-0">
                          <Badge tone={status.tone}>{status.label}</Badge>
                        </span>
                      ))}
                  </div>
                  <p className="mt-0.5 truncate text-[12px] text-neutral-400">
                    {p.packTitle}
                  </p>
                  <p className="text-[12px] text-neutral-400">
                    Pulled {pullTime(p.rolledAt)}
                    {sold && p.soldAt ? (
                      <span className="block sm:inline">
                        <span className="hidden sm:inline"> · </span>Sold{' '}
                        {pullTime(p.soldAt)}
                      </span>
                    ) : null}
                  </p>
                  <dl className="mt-2 grid grid-cols-3 gap-2">
                    <Figure label="Paid" value={paidLabel(p)} />
                    <Figure
                      label="Value"
                      value={p.value == null ? '—' : rm(p.value)}
                    />
                    <Figure
                      label="Sold for"
                      value={sold ? rm(p.soldFor as number) : '—'}
                      money={sold}
                    />
                  </dl>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {res.ok && (
        <Pager
          page={res.page}
          hasMore={res.hasMore}
          basePath="/vault/history"
        />
      )}
    </>
  );
}
