import { defineNavigationConfig } from '@mercurjs/dashboard-sdk';

// Vault redesign (docs/superpowers/specs/2026-10-14-admin-redesign-design.md
// §6.2): hide every core Medusa/Mercur sidebar item. Polycards uses none of
// these as a page; the data it does use (players, groups, stock) is reached
// through our own pages. Core items always render ABOVE custom ones, so the
// 9-entry menu only reads in order once all of them are gone. Hiding removes
// the sidebar entry only — the URL still opens (see the redirect routes for
// /orders, /customers and /reservations).
export default defineNavigationConfig({
  items: [
    'orders',
    'products',
    'offers',
    'collections',
    'categories',
    'inventory',
    'reservations',
    'customers',
    'customer-groups',
    'promotions',
    'campaigns',
    'price-lists',
    'stores',
    'reviews',
    'payouts',
  ].map((id) => ({ id, hidden: true })),
});
