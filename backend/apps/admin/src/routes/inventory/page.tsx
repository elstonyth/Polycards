import { Navigate } from 'react-router-dom';

// Replaces Medusa's Inventory Items list (reached through the "Inventory"
// breadcrumb on stock pages) with our Stock list, which reads the same Medusa
// stock levels plus cost and usage. Stock changes go through purchase invoices,
// not the core screens. /inventory/:id and /inventory/list stay as they are;
// the core list's own children (/inventory/create, /inventory/stock) become
// unreachable, which is the point (see the note in inventory/list/page.tsx).
const InventoryRedirect = () => <Navigate to="/inventory/list" replace />;

export default InventoryRedirect;
