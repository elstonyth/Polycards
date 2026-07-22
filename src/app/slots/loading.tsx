// /slots is force-dynamic and awaits the pack catalog before its first byte.
// Mirrors CatalogClient's shell: sticky chip rail over a grid of pack cards.
export default function SlotsLoading() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="mx-auto w-full animate-pulse px-fluid py-4 motion-reduce:animate-none"
    >
      <span className="sr-only">Loading packs</span>

      {/* Category chip rail */}
      <div className="glass-chrome mb-6 rounded-2xl border border-white/10 p-2">
        <div className="flex items-center gap-1.5 overflow-hidden">
          {[72, 96, 88, 104, 80].map((w, i) => (
            <div
              key={i}
              style={{ width: w }}
              className="h-9 shrink-0 rounded-xl bg-white/10"
            />
          ))}
        </div>
      </div>

      {/* Pack grid */}
      <div className="h-6 w-40 rounded bg-white/10" />
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => (
          <div
            key={i}
            className="aspect-[3/4] rounded-2xl border border-white/10 bg-white/5"
          />
        ))}
      </div>
    </div>
  );
}
