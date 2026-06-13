import { NextResponse } from 'next/server';
import { getCustomer } from '@/lib/data/customer';
import { getOwnProfileHandle } from '@/lib/data/profiles';

// Same-origin endpoint the client AuthProvider polls once on mount to learn the
// logged-in customer — the browser can't read the httpOnly JWT cookie directly,
// and a direct Store-API call from :4000 would be CORS-blocked.
export async function GET() {
  const customer = await getCustomer();
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
        }
      : null,
  });
}
