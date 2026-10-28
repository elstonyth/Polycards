import type { Permission, RouteConfig } from '@mercurjs/dashboard-sdk';
import { BuildingStorefront } from '@medusajs/icons';
import { Navigate } from 'react-router-dom';

// Sidebar group "Storefront" (Vault spec §6.1): opens its first page. Its path
// is /site because /storefront is the Card frame page itself.
export const config: RouteConfig = {
  label: 'pcNav.storefront',
  translationNs: 'translation',
  icon: BuildingStorefront,
  rank: 70,
  permissions: ['announcement:read' as Permission],
};

const StorefrontGroup = () => <Navigate to="/announcements" replace />;

export default StorefrontGroup;
