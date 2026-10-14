import { Navigate } from 'react-router-dom';

// Replaces Medusa's Orders list, which is always empty here — Polycards never
// creates Medusa orders. Login (`from ?? "/orders"`) and the root route (`/` →
// /orders) both land here, so this is how the admin opens on the Dashboard
// (/overview, spec §7). The handle's redirectTo sends a role WITHOUT
// order:read to the same place instead of an "access denied" screen
// (RoutePermissionGuard).
export const handle = { permissions: 'order:read', redirectTo: '/overview' };

const OrdersRedirect = () => <Navigate to="/overview" replace />;

export default OrdersRedirect;
