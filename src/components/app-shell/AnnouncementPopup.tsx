'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { usePathname } from 'next/navigation';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useConsent } from '@/lib/use-consent';
import { useModalA11y } from '@/lib/use-modal-a11y';
import type { Announcement } from '@/lib/data/schemas';
import {
  ANNOUNCEMENT_SEEN_KEY,
  announcementSig,
  mytDay,
  shouldShowAnnouncements,
} from '@/lib/announcement-seen';

// Let the page settle (and any dialog it opens on load) before interrupting.
const OPEN_DELAY_MS = 1200;

// The backend only stores /paths and http(s) URLs, but this becomes an href:
// re-check rather than trust, and treat anything else as "no link".
const linkKind = (href: string | null): 'internal' | 'external' | null =>
  !href
    ? null
    : href.startsWith('/') && !href.startsWith('//')
      ? 'internal'
      : /^https?:\/\//i.test(href)
        ? 'external'
        : null;

const roundIcon =
  'flex size-8 items-center justify-center rounded-full border border-white/20 bg-neutral-950/70 text-white';

/**
 * Admin-uploaded announcement popup (ads, upcoming drops, news — spec
 * 2026-10-06 §5). Every visitor, logged in or not, sees the live set once per
 * MYT day; the stored dismissal names the set (ids + updated_at), so a new or
 * edited announcement shows again at once. Several slides = one swipe
 * carousel (CSS scroll-snap), with arrows on desktop and dots everywhere.
 *
 * Waits for the cookie-consent answer (the banner owns the screen until
 * then), skips the spin reel, and never opens over another dialog.
 */
export function AnnouncementPopup({
  announcements,
}: {
  announcements: Announcement[];
}) {
  const pathname = usePathname();
  const consent = useConsent();
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  // Captured at hydration, before AuthModal strips ?auth= from the URL: a
  // visitor sent here to log in gets the login form, not an ad.
  const [arrivedForAuth] = useState(
    () =>
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).has('auth'),
  );
  const panelRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const sig = announcementSig(announcements);
  const close = () => setOpen(false);

  useModalA11y(panelRef, open, close);

  useEffect(() => {
    if (open || consent === null || arrivedForAuth) return;
    if (/^\/slots\/[^/]+\/spin/.test(pathname)) return;
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(ANNOUNCEMENT_SEEN_KEY);
    } catch {
      // Storage blocked: shows once per page load, which is the best we can do.
    }
    const day = mytDay(Date.now());
    if (!shouldShowAnnouncements(stored, sig, day)) return;
    const timer = window.setTimeout(() => {
      if (document.querySelector('[role="dialog"]')) return;
      // Recorded on OPEN, not on close: tapping through to a page or
      // reloading must not bring it straight back the same day.
      try {
        localStorage.setItem(
          ANNOUNCEMENT_SEEN_KEY,
          JSON.stringify({ sig, day }),
        );
      } catch {
        // Storage blocked — see above.
      }
      setIndex(0);
      setOpen(true);
    }, OPEN_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [open, consent, arrivedForAuth, pathname, sig]);

  if (!open) return null;

  const count = announcements.length;
  // scrollTo without `behavior` follows the track's CSS scroll-behavior, so
  // motion-safe:scroll-smooth below already honours reduced motion.
  const goTo = (i: number) => {
    const track = trackRef.current;
    if (track) track.scrollTo({ left: i * track.clientWidth });
  };

  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
      {/* Backdrop: mouse/touch close only, hidden from AT and the tab order —
          the X button and Esc cover keyboard and screen-reader users. */}
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        onClick={close}
        className="glass-scrim glass-stage absolute inset-0 cursor-default motion-safe:animate-[fadeIn_0.2s_ease-out]"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Announcements"
        tabIndex={-1}
        className="glass-panel relative z-10 w-full max-w-[420px] overflow-hidden rounded-2xl border outline-none motion-safe:animate-[modalIn_0.25s_ease-out]"
      >
        <div
          ref={trackRef}
          onScroll={(e) => {
            const t = e.currentTarget;
            setIndex(Math.round(t.scrollLeft / t.clientWidth));
          }}
          className="flex snap-x snap-mandatory overflow-x-auto overscroll-x-contain motion-safe:scroll-smooth [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {announcements.map((a, i) => (
            <div
              key={a.id}
              role="group"
              aria-roledescription="slide"
              aria-label={`${i + 1} of ${count}`}
              className="w-full shrink-0 snap-center"
            >
              <SlideLink href={a.link_url} onFollow={close}>
                <div className="relative aspect-[4/5] max-h-[calc(100dvh-11rem)] w-full bg-black/30">
                  <Image
                    src={a.image_url}
                    alt={a.title ?? 'Announcement'}
                    fill
                    sizes="(max-width: 452px) calc(100vw - 2rem), 420px"
                    className="object-contain"
                  />
                </div>
                {a.title && (
                  <p className="font-heading px-5 pt-4 pb-1 text-center text-xl leading-tight text-white">
                    {a.title}
                  </p>
                )}
              </SlideLink>
            </div>
          ))}
        </div>

        {count > 1 && (
          <div className="flex justify-center py-2">
            {announcements.map((a, i) => (
              <button
                key={a.id}
                type="button"
                onClick={() => goTo(i)}
                aria-label={`Show announcement ${i + 1}`}
                aria-current={i === index}
                className="flex size-6 items-center justify-center"
              >
                <span
                  className={`block size-1.5 rounded-full transition-colors ${
                    i === index ? 'bg-white' : 'bg-white/30'
                  }`}
                />
              </button>
            ))}
          </div>
        )}
        {count === 1 && <div className="h-4" />}

        {count > 1 && (
          <>
            <button
              type="button"
              onClick={() => goTo(index - 1)}
              disabled={index === 0}
              aria-label="Previous announcement"
              className="absolute top-[40%] left-1 hidden size-11 -translate-y-1/2 items-center justify-center disabled:opacity-0 sm:flex"
            >
              <span className={roundIcon}>
                <ChevronLeft size={16} aria-hidden="true" />
              </span>
            </button>
            <button
              type="button"
              onClick={() => goTo(index + 1)}
              disabled={index === count - 1}
              aria-label="Next announcement"
              className="absolute top-[40%] right-1 hidden size-11 -translate-y-1/2 items-center justify-center disabled:opacity-0 sm:flex"
            >
              <span className={roundIcon}>
                <ChevronRight size={16} aria-hidden="true" />
              </span>
            </button>
          </>
        )}

        <button
          type="button"
          onClick={close}
          aria-label="Close"
          className="absolute top-1 right-1 flex size-11 items-center justify-center focus-visible:outline-2 focus-visible:outline-white"
        >
          <span className={roundIcon}>
            <X size={16} aria-hidden="true" />
          </span>
        </button>
      </div>
    </div>,
    document.body,
  );
}

/** The whole slide is the tap target when it has a link: in-site paths stay
 *  in the app (and close the popup), anything else opens a new tab. */
function SlideLink({
  href,
  onFollow,
  children,
}: {
  href: string | null;
  onFollow: () => void;
  children: ReactNode;
}) {
  const kind = linkKind(href);
  if (kind === 'internal' && href) {
    return (
      <Link href={href} onClick={onFollow} className="block">
        {children}
      </Link>
    );
  }
  if (kind === 'external' && href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="block"
      >
        {children}
      </a>
    );
  }
  return <div>{children}</div>;
}
