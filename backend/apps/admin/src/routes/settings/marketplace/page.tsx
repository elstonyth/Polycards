import { Outlet } from 'react-router-dom';

// Merged over the core /settings/marketplace route, which keeps its children,
// so a super admin still gets the store settings screen through the Outlet.
// That screen also reads currencies, price preferences and the sales channel,
// and shows "An error occurred" without them. Every limited role lacks them,
// and /settings lands here, so those roles go to their own profile instead.
export const handle = {
  permissions: [
    'store:read',
    'currency:read',
    'sales_channel:read',
    'price_preference:read',
  ],
  redirectTo: '/settings/profile',
};

const MarketplaceSettings = () => <Outlet />;

export default MarketplaceSettings;
