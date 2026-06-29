import { Panel } from '@/components/account/ui';
import { cn } from '@/lib/utils';
import type { AchievementsData, Achievement } from '@/lib/actions/achievements';

const RARITY_CHIP: Record<string, string> = {
  Common: 'bg-white/10 text-white/80',
  Uncommon: 'bg-blue-500/15 text-blue-300',
  Rare: 'bg-emerald-500/15 text-emerald-300',
  Epic: 'bg-purple-500/15 text-purple-300',
  Legendary: 'bg-amber-500/15 text-amber-300',
};

const CATEGORY_LABEL: Record<string, string> = {
  cases_opened: 'Packs Opened',
  collection: 'Collection',
  spending: 'Spending',
};

function Row({ a }: { a: Achievement }) {
  const pct =
    a.progress.target > 0
      ? Math.min(
          100,
          Math.round((a.progress.current / a.progress.target) * 100),
        )
      : 0;
  return (
    <div
      className={cn(
        'rounded-xl border p-4',
        a.unlocked
          ? 'border-emerald-500/30 bg-emerald-500/[0.04]'
          : 'border-white/10 bg-white/[0.02]',
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-white">
            {a.name}
          </div>
          <div className="truncate text-xs text-white/50">{a.description}</div>
        </div>
        <span
          className={cn(
            'shrink-0 rounded px-2 py-0.5 text-[11px] font-semibold',
            RARITY_CHIP[a.rarity] ?? RARITY_CHIP.Common,
          )}
        >
          {a.rarity}
        </span>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
          <div
            className={cn(
              'h-full rounded-full',
              a.unlocked ? 'bg-emerald-400' : 'bg-white/40',
            )}
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="shrink-0 text-[11px] text-white/50">
          {a.unlocked
            ? `Unlocked · +${a.xp} XP`
            : `${a.progress.current} / ${a.progress.target}`}
        </span>
      </div>
    </div>
  );
}

export default function AchievementsSection({
  data,
}: {
  data: AchievementsData;
}) {
  const groups = Object.entries(CATEGORY_LABEL)
    .map(([cat, label]) => ({
      label,
      items: data.achievements.filter((a) => a.category === cat),
    }))
    .filter((g) => g.items.length > 0);

  const unlockedCount = data.achievements.filter((a) => a.unlocked).length;
  const pct = data.next
    ? Math.min(100, Math.round((data.totalXp / data.next.xpThreshold) * 100))
    : 100;

  return (
    <section className="mt-8">
      <h2 className="font-heading text-xl font-bold tracking-tight text-white">
        Achievements
      </h2>
      <Panel className="mt-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-[11px] uppercase tracking-wide text-white/40">
              Collector Level
            </p>
            <p className="mt-1 font-heading text-3xl font-bold text-white">
              {data.collectorLevel}
            </p>
          </div>
          <p className="text-sm text-white/50">
            {data.totalXp.toLocaleString('en-US')} XP · {unlockedCount}/
            {data.achievements.length} unlocked
          </p>
        </div>
        <div className="mt-3 h-2.5 w-full overflow-hidden rounded-full bg-white/10">
          <div
            className="h-full rounded-full bg-amber-400"
            style={{ width: `${pct}%` }}
          />
        </div>
        {data.next && (
          <p className="mt-2 text-[13px] text-white/60">
            {data.next.remaining.toLocaleString('en-US')} XP to Level{' '}
            {data.next.level}.
          </p>
        )}
      </Panel>

      {groups.map((g) => (
        <div key={g.label} className="mt-5">
          <h3 className="mb-2 text-sm font-semibold text-white/70">
            {g.label}
          </h3>
          <div className="grid gap-3 sm:grid-cols-2">
            {g.items.map((a) => (
              <Row key={a.key} a={a} />
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}
