'use client';

import { getCreditsLatest } from '@/lib/actions/vault';
import { createUnreadDot } from './create-unread-dot';

// The Me tab's money dot: the balance moved since the customer last opened
// /transactions. All mechanics live in createUnreadDot.
const { Provider, useDot } = createUnreadDot('credits', getCreditsLatest);

export const CreditDotProvider = Provider;
export const useCreditDot = useDot;
