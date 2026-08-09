import Link from 'next/link';
import { rarityRgb } from '@/lib/rarity';
import type { RecentPull } from '@/lib/data/packs';

/**
 * The Drop Board seam: a slim data marquee streaming real pulls between the
 * hero and the shelf. CSS-only loop (track duplicated, sp-scroll-x), pauses on
 * hover/press, static swipeable row under reduced motion. Whole band → /slots.
 */
export default function PullsMarquee({ pulls }: { pulls: RecentPull[] }) {
  if (pulls.length === 0) return null;

  const entries = pulls.slice(0, 12);
  const track = (ariaHidden: boolean) => (
    <div
      aria-hidden={ariaHidden || undefined}
      className="flex shrink-0 items-center gap-8 pr-8"
    >
      {entries.map((pull) => (
        <span
          key={`${ariaHidden ? 'dup-' : ''}${pull.id}`}
          className="flex items-center gap-2 whitespace-nowrap"
        >
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: `rgb(${rarityRgb(pull.rarity)})` }}
            aria-hidden
          />
          <span className="text-[13px] text-neutral-400">
            {pull.who} pulled
          </span>
          <span className="font-heading text-sm tabular-nums text-white">
            {pull.value}
          </span>
          <span className="text-[11px] text-neutral-400">{pull.agoLabel}</span>
        </span>
      ))}
    </div>
  );

  return (
    <Link
      href="/slots"
      aria-label="Live pulls — browse all packs"
      className="block w-full border-y border-white/10 bg-neutral-900 py-2.5 transition-colors hover:bg-neutral-800"
    >
      {/* Animated loop; reduced motion → static CLIPPED row (gutter lives on
          the wrapper — track padding would break the −50% loop invariant, see
          SlotStatusBar's marquee).

          Clipped, not scrollable, on purpose: `motion-reduce:overflow-x-auto`
          made this a scroll container with no keyboard access, which is a real
          axe `scrollable-region-focusable` failure for reduced-motion users.
          The repo's usual fix (RecentPullsSection: tabIndex={0} + role="group"
          + focus ring) can't apply here — this box sits INSIDE the band's
          <Link>, so it would nest focusable content in an anchor and add a
          permanent tab stop for a scroll that only exists under reduced
          motion. The same pulls render right below on / in
          RecentPullsSection, which IS keyboard-reachable, so clipping costs no
          content. Don't re-add overflow-x-auto. */}
      {/* Reduced-motion gutter mirrors .px-fluid (can't variant-prefix a custom class) */}
      <div className="overflow-hidden motion-reduce:[padding-inline:clamp(1rem,1.6vw,4.5rem)]">
        <div className="flex w-max animate-[sp-scroll-x_30s_linear_infinite] hover:[animation-play-state:paused] active:[animation-play-state:paused] motion-reduce:animate-none">
          {track(false)}
          <div className="motion-reduce:hidden">{track(true)}</div>
        </div>
      </div>
    </Link>
  );
}
