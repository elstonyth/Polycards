import Image from 'next/image';

// The Lucky Draw ticket: Codex "Crystal" art with the Polycards logo, picked
// by the operator 2026-10-25 (public/images/lucky-draw, alpha webp). Always
// decorative: the count or label beside it carries the meaning.
const RATIO = 960 / 674;

/** The ticket art at `width` CSS px (its height follows the art). */
export function TicketArt({
  width,
  className,
  eager,
}: {
  width: number;
  className?: string;
  /** Load now, not when scrolled near (Next 16 deprecates `priority`). */
  eager?: boolean;
}) {
  return (
    <Image
      src="/images/lucky-draw/ticket.webp"
      alt=""
      aria-hidden
      draggable={false}
      width={width}
      height={Math.round(width / RATIO)}
      loading={eager ? 'eager' : undefined}
      className={className}
    />
  );
}
