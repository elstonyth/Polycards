import type { RouteConfig } from '@mercurjs/dashboard-sdk';
import { CreditCard } from '@medusajs/icons';
import { Navigate } from 'react-router-dom';

// Sidebar group "Payments" (Vault spec §6.1). It has no page of its own: the
// entry opens the group's first page, where the sidebar shows the group open.
export const config: RouteConfig = {
  label: 'pcNav.payments',
  translationNs: 'translation',
  icon: CreditCard,
  rank: 20,
  permissions: ['payment:read'],
};

const PaymentsGroup = () => <Navigate to="/withdrawals" replace />;

export default PaymentsGroup;
