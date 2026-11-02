'use client';

import Link from 'next/link';
import { useState, type ComponentProps } from 'react';

/**
 * For links repeated down a list whose route has a loading.tsx. Prefetching all
 * of them in view is a pod render each, per page view; prefetching none means a
 * tap shows nothing until the server answers. So this prefetches on intent, the
 * pattern in Next's linking guide, with touch added for phones.
 */
export function IntentLink({
  onMouseEnter,
  onTouchStart,
  ...props
}: ComponentProps<typeof Link>) {
  const [intent, setIntent] = useState(false);
  return (
    <Link
      {...props}
      prefetch={intent ? null : false}
      onMouseEnter={(event) => {
        setIntent(true);
        onMouseEnter?.(event);
      }}
      onTouchStart={(event) => {
        setIntent(true);
        onTouchStart?.(event);
      }}
    />
  );
}
