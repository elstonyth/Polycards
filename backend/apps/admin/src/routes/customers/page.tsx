import { Navigate } from 'react-router-dom';

// Replaces Medusa's Customers list (titled "Players" by our customers.domain
// rename) with our Players page — one player list, not two. It also catches
// the player profile's "Players" breadcrumb, which links here. Profiles at
// /customers/:id are unaffected.
const CustomersRedirect = () => <Navigate to="/players" replace />;

export default CustomersRedirect;
