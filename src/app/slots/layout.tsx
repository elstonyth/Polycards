import type { ReactNode } from 'react';

// The catalog, the pack pages and the spin stage draw their 3D against ink
// black, so they opt out of the graphite skin (globals.css, `data-ink`).
export default function SlotsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <span data-ink hidden />
      {children}
    </>
  );
}
