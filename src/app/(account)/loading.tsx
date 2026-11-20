// Route-group fallback for all 11 account pages. They are force-dynamic and
// await 1-6 backend reads before their first byte (me/page.tsx awaits five in
// parallel, then a sixth serially), so without this the tap does nothing
// visible until the whole payload lands.
//
// Shaped like the real pages, not a spinner: AccountSkeleton picks the shape
// for the destination (Vault, Pull history, Lucky Draw, Me, coin flip, or
// AccountHeader over stacked panels for the rest).
import { SkeletonExit } from '@/components/PageTransition';
import { AccountSkeleton } from '@/components/account/AccountSkeleton';

export default function AccountLoading() {
  return (
    <SkeletonExit>
      <AccountSkeleton />
    </SkeletonExit>
  );
}
