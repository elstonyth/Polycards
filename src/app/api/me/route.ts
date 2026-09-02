import { NextResponse } from 'next/server';
import { clearAuthToken, getCustomerSession } from '@/lib/data/customer';
import { getOwnProfileHandle } from '@/lib/data/profiles';

// Same-origin endpoint the client AuthProvider polls once on mount to learn the
// logged-in customer — the browser can't read the httpOnly JWT cookie directly,
// and a direct Store-API call from :4000 would be CORS-blocked.
export async function GET() {
  const { customer, stale } = await getCustomerSession();
  // A token the backend rejected outright (401) is dead weight: nothing else
  // ever deletes it, and every surface that only checks cookie PRESENCE keeps
  // reading it as "logged in" while the header says logged out. This is the
  // one request every load makes AND a Route Handler, so reap it here.
  if (stale) await clearAuthToken();
  // The backend lazily assigns the public profile handle on this call, so
  // every logged-in session ends up with a working "My Profile" link.
  const handle = customer ? await getOwnProfileHandle() : null;
  return NextResponse.json({
    customer: customer
      ? {
          id: customer.id,
          email: customer.email,
          first_name: customer.first_name,
          last_name: customer.last_name,
          handle,
          avatar_url:
            typeof (customer.metadata ?? {})['avatar_url'] === 'string'
              ? ((customer.metadata ?? {})['avatar_url'] as string)
              : null,
        }
      : null,
  });
}
