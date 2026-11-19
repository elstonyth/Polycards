'use client';

import { TabLink } from './TabLink';
import { TABS } from './tabs';

/**
 * Bottom tab bar — the primary nav on phones (hidden lg+, where AppHeader
 * carries the same seven destinations). Ink bar, hairline top edge, safe-area
 * padding; active tab is Paper White per DESIGN.md navigation spec. Each item
 * is a TabLink, shared with AppHeader's pills.
 */
export default function TabBar() {
  return (
    <nav
      data-site-chrome
      aria-label="Primary"
      // Its own still layer during page transitions (globals.css).
      className="glass-chrome fixed inset-x-0 bottom-0 z-50 border-t border-white/10 pb-[env(safe-area-inset-bottom)] [view-transition-name:tab-bar] lg:hidden"
    >
      <div className="mx-auto flex h-16 max-w-md items-stretch">
        {TABS.map((tab) => (
          <TabLink key={tab.href} tab={tab} variant="bar" />
        ))}
      </div>
    </nav>
  );
}
