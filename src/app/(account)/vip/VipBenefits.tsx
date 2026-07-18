import type { VipLevel } from '@/lib/actions/vip';
import { milestoneBenefits } from './vip-benefits';

/** "Level Privilege Benefits" — the milestone perks (frames, box upgrades,
 *  referral bumps) by level. Per-level vouchers live on the carousel cards. */
export function VipBenefits({ levels }: { levels: VipLevel[] }) {
  const milestones = milestoneBenefits(levels);
  if (milestones.length === 0) return null;
  return (
    <section aria-labelledby="vip-benefits-heading" className="mt-6">
      <h2
        id="vip-benefits-heading"
        className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-neutral-400"
      >
        Level Privilege Benefits
      </h2>
      <ol className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03]">
        {milestones.map((m, i) => (
          <li
            key={m.level}
            className={`flex items-start gap-3 px-4 py-3 ${
              i > 0 ? 'border-t border-white/5' : ''
            }`}
          >
            <span className="font-heading text-chase shrink-0 text-sm">
              LV {m.level}
            </span>
            <span className="text-[13px] text-white/80">
              {m.perks.join(' · ')}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
