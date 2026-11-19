'use client';

import { useEffect, useState } from 'react';
import { reloadForVersionSkew } from '@/lib/version-skew';
import { GAMES_EVENT } from './games';

type Body = typeof import('./GamesSheetBody').GamesSheetBody;

/** Starts fetching the sheet's chunk on the press that will open it
 *  (pointerdown), so the first open does not wait out the whole download
 *  after the click. Silent on failure: the open below imports again and
 *  handles a version skew itself. */
export function preloadGamesSheet(): void {
  void import('./GamesSheetBody').catch(() => undefined);
}

/** Keeps motion (~120 KB of parsed JS) off every page: the root layout mounts
 *  this, and the sheet only loads when the Games tab first opens it. Not
 *  next/dynamic, for the reason on AuthModalLoader. */
export function GamesSheet() {
  const [Body, setBody] = useState<Body | null>(null);
  const [openedOn, setOpenedOn] = useState('');

  useEffect(() => {
    if (Body) return;
    const open = () => {
      setOpenedOn(window.location.pathname);
      void import('./GamesSheetBody').then(
        (m) => setBody(() => m.GamesSheetBody),
        (error: unknown) => reloadForVersionSkew(error),
      );
    };
    window.addEventListener(GAMES_EVENT, open);
    return () => window.removeEventListener(GAMES_EVENT, open);
  }, [Body]);

  return Body ? <Body openedOn={openedOn} /> : null;
}
