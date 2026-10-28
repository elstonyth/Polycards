import { useQuery } from '@tanstack/react-query';
import type { AutomationActivity } from '../../../../../packages/api/src/api/utils/automation-live-types';

declare const __BACKEND_URL__: string;

async function readActivity(
  days: number,
  signal: AbortSignal,
): Promise<AutomationActivity> {
  const response = await fetch(
    `${__BACKEND_URL__}/admin/automation/activity?days=${days}`,
    { credentials: 'include', cache: 'no-store', signal },
  );
  if (!response.ok) throw new Error(`Activity failed (${response.status}).`);
  return response.json() as Promise<AutomationActivity>;
}

/** House-account draws from the pull ledger, refreshed every 30 s. */
export function useAutomationActivity(days: number) {
  return useQuery({
    queryKey: ['automation-activity', days],
    queryFn: ({ signal }) => readActivity(days, signal),
    refetchInterval: 30_000,
    placeholderData: (previous) => previous,
  });
}
