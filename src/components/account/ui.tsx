import { type ReactNode } from 'react';

export function AccountHeader({ title, sub }: { title: string; sub?: string }) {
  return (
    <header className="mb-6">
      <h1 className="font-heading text-2xl font-bold tracking-tight text-white sm:text-3xl">
        {title}
      </h1>
      {sub && <p className="mt-1.5 text-sm text-white/50">{sub}</p>}
    </header>
  );
}

export function Panel({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-2xl border border-white/10 bg-white/[0.03] p-5 sm:p-6 ${className}`}
    >
      {children}
    </div>
  );
}

export function StatCards({
  items,
}: {
  items: { label: string; value: string; sub?: string }[];
}) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {items.map((s) => (
        <div
          key={s.label}
          className="rounded-2xl border border-white/10 bg-white/[0.03] p-4"
        >
          <p className="text-[11px] uppercase tracking-wide text-white/40">
            {s.label}
          </p>
          <p className="mt-1 font-heading text-2xl font-bold text-white">
            {s.value}
          </p>
          {s.sub && <p className="mt-0.5 text-[12px] text-white/50">{s.sub}</p>}
        </div>
      ))}
    </div>
  );
}

export function MockTable({
  head,
  rows,
}: {
  head: string[];
  rows: ReactNode[][];
}) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-white/10 bg-white/[0.03]">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-white/10 text-left text-[12px] uppercase tracking-wide text-white/40">
            {head.map((h) => (
              <th key={h} className="px-4 py-3 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr
              key={i}
              className="border-b border-white/5 last:border-0 hover:bg-white/[0.02]"
            >
              {r.map((c, j) => (
                <td
                  key={j}
                  className="whitespace-nowrap px-4 py-3 text-white/80"
                >
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const TONES = {
  green: 'bg-buyback/15 text-buyback-fg',
  amber: 'bg-amber-500/15 text-amber-400',
  sky: 'bg-sky-500/15 text-sky-400',
  neutral: 'bg-white/10 text-white/70',
} as const;

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: keyof typeof TONES;
}) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}

export function DemoNote() {
  return (
    <p className="mt-5 text-[11px] text-white/35">
      Demo only — this account area connects to the backend in a later phase.
    </p>
  );
}
