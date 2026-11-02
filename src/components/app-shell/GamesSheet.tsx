'use client';

import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import { GAMES_EVENT } from './games';

const GamesSheetBody = dynamic(
  () => import('./GamesSheetBody').then((m) => m.GamesSheetBody),
  { ssr: false },
);

/** Keeps motion (~120 KB of parsed JS) off every page: the root layout mounts
 *  this, and the sheet only loads when the Games tab first opens it. */
export function GamesSheet() {
  const [opened, setOpened] = useState(false);

  useEffect(() => {
    const open = () => setOpened(true);
    window.addEventListener(GAMES_EVENT, open, { once: true });
    return () => window.removeEventListener(GAMES_EVENT, open);
  }, []);

  return opened ? <GamesSheetBody /> : null;
}
