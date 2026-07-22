// Pack detail is force-dynamic and awaits three backend reads (pack, detail,
// recent pulls) before its first byte. Mirrors PackDetailClient's shell: back
// link, then the stage / configurator two-column split.
export default function PackDetailLoading() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="mx-auto w-full animate-pulse px-fluid pb-28 pt-4 motion-reduce:animate-none lg:pb-4"
    >
      <span className="sr-only">Loading pack</span>

      <div className="mb-4 h-4 w-24 rounded bg-white/10" />

      <div className="grid items-start gap-6 lg:grid-cols-[1.55fr_1fr]">
        {/* Stage */}
        <div className="aspect-[4/3] rounded-2xl border border-white/10 bg-white/5" />
        {/* Configurator */}
        <div className="flex flex-col gap-3">
          <div className="h-7 w-2/3 rounded-lg bg-white/10" />
          <div className="h-5 w-1/3 rounded bg-white/5" />
          <div className="h-14 rounded-2xl border border-white/10 bg-white/5" />
          <div className="h-12 rounded-full bg-white/10" />
        </div>
      </div>

      {/* Top hits rail */}
      <div className="mt-8 h-6 w-32 rounded bg-white/10" />
      <div className="mt-4 flex gap-3 overflow-hidden">
        {Array.from({ length: 6 }, (_, i) => (
          <div
            key={i}
            className="aspect-[0.598] w-28 shrink-0 rounded-xl border border-white/10 bg-white/5"
          />
        ))}
      </div>
    </div>
  );
}
