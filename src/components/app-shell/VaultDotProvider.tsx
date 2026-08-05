'use client';

import { getVaultLatest } from '@/lib/actions/vault';
import { createUnreadDot } from './create-unread-dot';

// The Vault tab's unread dot: something arrived in the vault since the customer
// last opened it. All mechanics live in createUnreadDot — see the comments
// there, each of which is a bug someone already hit.
const { Provider, useDot } = createUnreadDot('vault', getVaultLatest);

export const VaultDotProvider = Provider;
export const useVaultDot = useDot;
