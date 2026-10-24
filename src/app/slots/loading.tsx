// /slots is force-dynamic and awaits the pack catalog before its first byte.
// Mirrors CatalogClient's shell: franchise switch over a grid of pack cards.
export default function SlotsLoading() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="mx-auto w-full animate-pulse px-fluid py-4 motion-reduce:animate-none"
    >
      <span className="sr-only">Loading packs</span>

      {/* Franchise switch */}
      <div className="mb-6 flex gap-1 rounded-full border border-white/10 bg-neutral-900 p-1">
        {[0, 1].map((i) => (
          <div key={i} className="h-12 flex-1 rounded-full bg-white/10" />
        ))}
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
