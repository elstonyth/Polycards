import type { Permission, RouteConfig } from '@mercurjs/dashboard-sdk';
import { Star } from '@medusajs/icons';
import { Navigate } from 'react-router-dom';

// Sidebar group "Rewards" (Vault spec §6.1): opens its first page.
export const config: RouteConfig = {
  label: 'pcNav.rewards',
  translationNs: 'translation',
  icon: Star,
  rank: 60,
  permissions: ['rewards_setting:read' as Permission],
};

const RewardsGroup = () => <Navigate to="/daily-rewards" replace />;

export default RewardsGroup;
