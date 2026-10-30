'use client';

import { useRouter } from 'next/navigation';
import { X } from 'lucide-react';

/**
 * A challenge prize opened as a page: Close returns the visitor to where they
 * tapped it, in the same words as CardDetailOverlay's Close.
 */
export function CardCloseButton() {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={() => {
        // canGoBack counts only this site's entries, so Close can't leave it.
        // shortcut: older Safari/Firefox lack it and history.length can't tell
        // an in-app entry from an off-site one, drop the fallback when they age out.
        if (window.navigation?.canGoBack ?? window.history.length > 1) {
          router.back();
        } else {
          router.push('/leaderboard');
        }
      }}
      className="rise-in mb-6 inline-flex min-h-11 w-fit items-center gap-1.5 rounded-full border border-white/15 bg-white/5 px-4 text-sm font-medium text-white transition-colors hover:bg-white/10"
    >
      <X className="h-4 w-4" aria-hidden /> Close
    </button>
  );
}
