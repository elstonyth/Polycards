import dynamic from 'next/dynamic';

// Only pulled in when a draw lands or a replay opens, so the arena costs a page
// nothing until then.
export const ArenaShow = dynamic(
  () => import('./ArenaShow').then((m) => ({ default: m.ArenaShow })),
  { ssr: false },
);
