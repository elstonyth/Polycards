// The "Open Pack" tap lands here, and the page is force-dynamic behind three
// backend reads. This renders a static frame of SlotMachineClient's room:
// the same fixed, full-viewport bg-neutral-950 surface with the same top
// plate, so the transition never flashes the white default.
export default function SpinLoading() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-0 z-[100] flex flex-col bg-neutral-950 pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-[env(safe-area-inset-top)] text-neutral-50"
    >
      <span className="sr-only">Loading the slot machine</span>

      {/* Top plate */}
      <div className="flex animate-pulse items-center justify-between gap-3 px-fluid py-2 motion-reduce:animate-none sm:gap-4 sm:py-4">
        <div className="h-4 w-14 rounded bg-white/10" />
        <div className="h-7 w-32 rounded-full bg-white/10" />
      </div>

      {/* Reel stage: three dark columns, no rarity colour anywhere (the room
          stays neutral until a real spin settles). */}
      <div className="flex flex-1 items-center justify-center px-fluid">
        <div className="flex w-full max-w-3xl animate-pulse gap-2 motion-reduce:animate-none sm:gap-3">
          {Array.from({ length: 3 }, (_, i) => (
            <div
              key={i}
              className="aspect-square flex-1 rounded-2xl border border-white/10 bg-white/[0.03]"
            />
          ))}
        </div>
      </div>

      {/* Controls plate */}
      <div className="flex animate-pulse justify-center px-fluid py-6 motion-reduce:animate-none">
        <div className="h-12 w-56 rounded-full bg-white/10" />
      </div>
    </div>
  );
}
