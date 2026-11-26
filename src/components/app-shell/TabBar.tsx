'use client';

import { TabLink } from './TabLink';
import { PHONE_TABS } from './tabs';

/**
 * Bottom tab bar — the primary nav on phones (hidden lg+, where AppHeader
 * links all seven destinations). A slim floating dock of five icon tabs
 * (PHONE_TABS): the tab you are on is a grey pill that opens to show its
 * label, the same move as the pack category bar. Each item is a TabLink,
 * shared with AppHeader's links.
 */
export default function TabBar() {
  return (
    <nav
      data-site-chrome
      aria-label="Primary"
      // Its own still layer during page transitions (globals.css). The 56px
      // dock plus its 8px gap is the old bar's 64px, so everything that sits
      // above the bar keeps its place. The strip beside the dock lets taps
      // through to the page.
      className="tab-bar-fade pointer-events-none fixed inset-x-0 bottom-0 z-50 px-3 pb-[max(env(safe-area-inset-bottom),0.5rem)] [view-transition-name:tab-bar] lg:hidden"
    >
      {/* 95%, above glass-chrome's 82%: page text passes right behind a
          floating dock. The lit top rim is the glass edge. One width on every
          page: the idle tabs share what the open one leaves. */}
      <div className="glass-chrome pointer-events-auto mx-auto flex h-14 w-full max-w-88 items-center rounded-full border border-white/10 bg-neutral-900/95! p-1.5 shadow-[0_14px_34px_-12px_rgb(0_0_0/0.95),inset_0_1px_0_rgb(255_255_255/0.1)]">
        {PHONE_TABS.map((tab) => (
          <TabLink key={tab.href} tab={tab} variant="bar" />
        ))}
      </div>
    </nav>
  );
}
