import { Navigate } from 'react-router-dom';

// Replaces Medusa's Products list. Every Medusa product here mirrors a prize
// card, and edits made on the core product screens don't sync back to the
// card, so the list (still reached through the "Products" breadcrumb on the
// Add stock pages) sends operators to Cards instead. Detail routes
// (/products/:id) and our /products/from-* pages are unaffected.
const ProductsRedirect = () => <Navigate to="/cards" replace />;

export default ProductsRedirect;
