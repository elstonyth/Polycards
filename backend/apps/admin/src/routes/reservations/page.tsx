import { Navigate } from 'react-router-dom';

// Replaces Medusa's Reservations list. Polycards never reserves stock, but a
// reservation made by hand here would silently lower gacha stock
// (modules/packs/card-stock.ts subtracts reserved quantity), so the page is
// redirected to our Stock list rather than just hidden.
const ReservationsRedirect = () => <Navigate to="/inventory/list" replace />;

export default ReservationsRedirect;
