'use client';

import { TabLink, TabMarker } from './TabLink';
import { PHONE_TABS } from './tabs';

/**
 * Bottom tab bar — the primary nav on phones (hidden lg+, where AppHeader
 * links all seven destinations). A floating glass pill with five tabs
 * (PHONE_TABS), Home raised in the centre. Each item is a TabLink, shared
 * with AppHeader's links.
 */
export default function TabBar() {
  return (
    <nav
      data-site-chrome
      aria-label="Primary"
      // Its own still layer during page transitions (globals.css). The 56px
      // pill plus its 8px gap is the old bar's 64px, so everything that sits
      // above the bar keeps its place. The strip beside the pill lets taps
      // through to the page.
      className="tab-bar-fade pointer-events-none fixed inset-x-0 bottom-0 z-50 px-3 pb-[max(env(safe-area-inset-bottom),0.5rem)] [view-transition-name:tab-bar] lg:hidden"
    >
      {/* 95%, above glass-chrome's 82%: a floating pill has page text passing
          right behind its labels, where the old full-width bar had its own edge.
          The lit top rim is the glass edge. */}
      <div className="glass-chrome pointer-events-auto relative mx-auto flex h-14 max-w-md items-stretch rounded-full border border-white/10 bg-neutral-900/95! shadow-[0_14px_34px_-12px_rgb(0_0_0/0.95),inset_0_1px_0_rgb(255_255_255/0.1)]">
        {/* The glass lens under the tab you are on: a lit rim above, a faint
            one below. A fifth of the bar: PHONE_TABS.length. */}
        <TabMarker tabs={PHONE_TABS} className="inset-y-1 left-0 w-1/5">
          <span className="absolute inset-x-0.5 inset-y-0 rounded-full bg-white/10 shadow-[inset_0_1px_0_rgb(255_255_255/0.22),inset_0_-1px_0_rgb(255_255_255/0.06)]" />
        </TabMarker>
        {PHONE_TABS.map((tab) => (
          <TabLink key={tab.href} tab={tab} variant="bar" />
        ))}
      </div>
    </nav>
  );
}
