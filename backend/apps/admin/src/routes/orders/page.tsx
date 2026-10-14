import { Navigate } from 'react-router-dom';

// Replaces Medusa's Orders list, which is always empty here — Polycards never
// creates Medusa orders. Login (`from ?? "/orders"`) and the root route (`/` →
// /orders) both land here, so this is how the dashboard opens on our home page.
// Phase 1 home is the Stats page; Phase 2 points this at /overview (Vault spec
// §6.2a). The handle's redirectTo sends a role WITHOUT order:read to the same
// place instead of an "access denied" screen (RoutePermissionGuard).
export const handle = { permissions: 'order:read', redirectTo: '/stats' };

const OrdersRedirect = () => <Navigate to="/stats" replace />;

export default OrdersRedirect;
