// Route-group fallback for all 11 account pages. They are force-dynamic and
// await 1-6 backend reads before their first byte (me/page.tsx awaits five in
// parallel, then a sixth serially), so without this the tap does nothing
// visible until the whole payload lands.
//
// Shaped like the real pages: AccountHeader (title + sub) over stacked
// panels, not a spinner.
export default function AccountLoading() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="animate-pulse motion-reduce:animate-none"
    >
      <span className="sr-only">Loading</span>

      {/* AccountHeader */}
      <header className="mb-6">
        <div className="h-8 w-44 rounded-lg bg-white/10 sm:h-9" />
        <div className="mt-2.5 h-4 w-64 max-w-full rounded bg-white/5" />
      </header>

      {/* Panels */}
      <div className="flex flex-col gap-3">
        <div className="h-40 rounded-2xl border border-white/10 bg-white/[0.03]" />
        <div className="h-28 rounded-2xl border border-white/10 bg-white/[0.03]" />
        <div className="h-28 rounded-2xl border border-white/10 bg-white/[0.03]" />
      </div>
    </div>
  );
}
