'use client';

import { getLuckyDrawLatest } from '@/lib/actions/lucky-draw';
import { createUnreadDot } from './create-unread-dot';

// The Draw tab's dot: a gate went live since the customer last opened the Lucky
// Draw (boss 2026-11-01). All mechanics live in createUnreadDot.
const { Provider, useDot } = createUnreadDot('draw', getLuckyDrawLatest);

export const DrawDotProvider = Provider;
export const useDrawDot = useDot;
