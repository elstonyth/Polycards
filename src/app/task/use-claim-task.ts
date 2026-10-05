'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { claimTaskReward } from '@/lib/actions/tasks';
import type { TaskEntry } from '@/lib/data/schemas';

// Every way a claim can decline, in the customer's words.
const CLAIM_FAILURE_COPY: Record<string, string> = {
  already_claimed: 'Already claimed.',
  not_completed: 'Not completed yet.',
  window_closed: 'This task has ended.',
  not_found: 'This task is no longer available.',
};
const CLAIM_FALLBACK = 'Could not claim this right now.';

/** One claim flow for a task row and a check-in milestone tile alike. A pack
 *  reward is a free RIP, so its claim hands the player to the slot to take
 *  it; the entitlement is already recorded server-side, so if they never
 *  arrive it waits for them on /task rather than evaporating. */
export function useClaimTask(onDone: (message: string) => void) {
  const [pending, startTransition] = useTransition();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const router = useRouter();
  const claim = (task: TaskEntry) => {
    setPendingId(task.id);
    startTransition(async () => {
      const res = await claimTaskReward(task.id);
      if (res.ok && res.claimed) {
        if (res.spin) {
          onDone('Free rip unlocked — spinning it up…');
          router.push(
            `/slots/${encodeURIComponent(res.spin.packId)}/spin?freeRip=${encodeURIComponent(res.spin.claimId)}`,
          );
          return;
        }
        onDone(
          res.rewardType === 'credit'
            ? 'Credit added to your wallet.'
            : 'Card added to your vault.',
        );
      } else if (res.ok && !res.claimed) {
        onDone(CLAIM_FAILURE_COPY[res.reason] ?? CLAIM_FALLBACK);
      } else if (!res.ok) {
        onDone(res.error);
      }
      router.refresh();
    });
  };
  return { claim, pendingId: pending ? pendingId : null };
}
