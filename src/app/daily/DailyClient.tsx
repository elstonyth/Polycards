'use client';

import { useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { AlertCircle, Gift, Package, Sparkles } from 'lucide-react';
import { rm } from '@/lib/format';
import { useTopUp } from '@/components/app-shell/TopUpProvider';
import Reveal from '@/components/Reveal';
import { PrizeReveal } from '@/components/rewards/PrizeReveal';
import { WithdrawForm } from '@/components/rewards/WithdrawForm';
import { Pill } from '@/components/ui/pill';
import {
  getDaily,
  drawDailyBox,
  type DailyState,
  type DrawPrize,
} from '@/lib/actions/daily';

const TIER_RANGE: Record<string, string> = {
  a: 'LV 1–9',
  b: 'LV 10–19',
  c: 'LV 20–29',
  d: 'LV 30–39',
  e: 'LV 40–49',
  f: 'LV 50–59',
  g: 'LV 60–69',
  h: 'LV 70–79',
  i: 'LV 80–89',
  j: 'LV 90–99',
  Z: 'LV 100',
};

function countdown(nextReset: string): string {
  const ms = new Date(nextReset).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return '0h 0m';
  const totalMinutes = Math.floor(ms / 60_000);
  const hh = Math.floor(totalMinutes / 60);
  const mm = totalMinutes % 60;
  return `${hh}h ${mm}m`;
}

export default function DailyClient({ initial }: { initial: DailyState }) {
  const [state, setState] = useState<DailyState>(initial);
  const [drawing, setDrawing] = useState(false);
  const [drawError, setDrawError] = useState<string | null>(null);
  const [drawResult, setDrawResult] = useState<DrawPrize | null>(null);
  const [withdrawing, setWithdrawing] = useState<string | null>(null);
  const { refreshBalance } = useTopUp();

  const { redemptionEnabled, box, shipPrizes } = state;

  async function refresh() {
    setDrawResult(null);
    const fresh = await getDaily();
    if (fresh.ok) setState(fresh.state);
  }

  async function handleDraw() {
    if (drawing || !box) return;
    setDrawing(true);
    setDrawError(null);
    const res = await drawDailyBox();
    setDrawing(false);
    if (!res.ok) {
      setDrawError(res.error);
      return;
    }
    if (res.status === 'capped') {
      setDrawError("You've used all your draws for today. Come back tomorrow!");
      return;
    }
    if (res.status === 'unavailable') {
      setDrawError("The daily box isn't available yet. Check back soon.");
      return;
    }
    if (res.prize) {
      if (res.prize.kind === 'credit' && res.prize.amountMyr != null) {
        void refreshBalance(); // re-read the authoritative balance (prize is a delta, not the new balance)
      }
      setDrawResult(res.prize);
    } else {
      setDrawError('Draw recorded, but no prize data was returned.');
    }
  }

  const drawsLeft = box ? Math.max(0, box.drawsPerDay - box.drawsToday) : 0;
  const canDraw = redemptionEnabled && !!box && drawsLeft > 0 && !drawing;

  let drawLabel = 'Open box';
  if (drawing) drawLabel = 'Opening…';
  else if (!redemptionEnabled) drawLabel = 'Rewards are coming soon';
  else if (!box) drawLabel = 'No box for your tier yet';
  else if (drawsLeft <= 0)
    drawLabel = `Come back in ${countdown(box.nextReset)}`;

  const vaultedPrizes = shipPrizes.filter(
    (p) => p.prizeKind === 'product' && p.status === 'vaulted',
  );

  return (
    <div className="mx-auto w-full max-w-md">
      {drawResult && <PrizeReveal prize={drawResult} onClose={refresh} />}

      {/* ---- 1. Box hero ---- */}
      <Reveal>
        <div className="text-center">
          <h1 className="font-heading text-3xl text-white">DAILY REWARDS</h1>
          <p className="mt-1 text-[13px] text-neutral-400">
            {box
              ? `Tier ${box.tier.toUpperCase()} box · ${TIER_RANGE[box.tier] ?? ''} · free draw every day`
              : 'Open a box every day'}
          </p>
          <p className="mt-1 text-[13px] text-neutral-400">
            <Link
              href="/vip"
              className="text-white/80 underline-offset-2 hover:text-white hover:underline"
            >
              Level up for better boxes →
            </Link>
          </p>
        </div>

        {box && box.prizes.length > 0 && (
          <div className="mt-5 flex gap-2 overflow-x-auto pb-1">
            {box.prizes.map((p, i) => (
              <div
                key={i}
                className="flex h-16 w-16 shrink-0 flex-col items-center justify-center gap-1 rounded-xl border border-white/10 bg-neutral-900 p-1"
              >
                {p.image ? (
                  <div className="relative h-8 w-8">
                    <Image
                      src={p.image}
                      alt={p.title ?? p.kind}
                      fill
                      sizes="32px"
                      className="object-contain"
                    />
                  </div>
                ) : p.kind === 'credit' || p.kind === 'voucher' ? (
                  <span className="text-[10px] font-bold text-buyback-fg">
                    {rm(p.amountMyr ?? 0)}
                  </span>
                ) : (
                  <Gift className="h-5 w-5 text-neutral-400" aria-hidden />
                )}
              </div>
            ))}
          </div>
        )}

        {drawError && (
          <p
            role="alert"
            className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-[13px] font-medium text-red-300"
          >
            {drawError}
          </p>
        )}

        <Pill
          onClick={handleDraw}
          disabled={!canDraw}
          size="lg"
          className="mt-5 w-full"
        >
          <Sparkles className="h-4 w-4" aria-hidden />
          {drawLabel}
        </Pill>
      </Reveal>

      {/* ---- 3. Prizes to ship ---- */}
      {vaultedPrizes.length > 0 && (
        <Reveal className="mt-8" as="section" aria-labelledby="ship-heading">
          <h2
            id="ship-heading"
            className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-neutral-400"
          >
            <Package className="h-4 w-4" aria-hidden />
            Prizes to ship
          </h2>
          <div className="space-y-2">
            {vaultedPrizes.map((prize) => {
              const snap = prize.prizeSnapshot;
              const title =
                snap && typeof snap['title'] === 'string'
                  ? snap['title']
                  : 'Prize';
              const image =
                snap && typeof snap['image'] === 'string'
                  ? snap['image']
                  : null;
              const isWithdrawing = withdrawing === prize.pullId;
              return (
                <div
                  key={prize.pullId}
                  className="rounded-2xl border border-white/10 bg-neutral-900 p-4"
                >
                  <div className="flex items-start gap-4">
                    {image && (
                      <div className="relative h-20 w-14 shrink-0 overflow-hidden rounded">
                        <Image
                          src={image}
                          alt={title}
                          fill
                          sizes="56px"
                          className="object-contain"
                        />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-white">{title}</p>
                      <p className="mt-0.5 text-[12px] text-neutral-400">
                        Won {prize.drawDay}
                      </p>
                      {!isWithdrawing ? (
                        <button
                          type="button"
                          onClick={() => setWithdrawing(prize.pullId)}
                          className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-4 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-white/10"
                        >
                          <Package className="h-3.5 w-3.5" aria-hidden />
                          Ship it
                        </button>
                      ) : (
                        <WithdrawForm
                          pullId={prize.pullId}
                          onDone={() => {
                            setWithdrawing(null);
                            void refresh();
                          }}
                          onCancel={() => setWithdrawing(null)}
                        />
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </Reveal>
      )}

      {!redemptionEnabled && (
        <p className="mt-6 flex items-center gap-2 rounded-xl border border-white/10 bg-neutral-900 px-4 py-3 text-[12px] text-neutral-400">
          <AlertCircle className="h-4 w-4 shrink-0" aria-hidden />
          Rewards are coming soon — draws and claims will unlock once redemption
          opens.
        </p>
      )}
    </div>
  );
}
