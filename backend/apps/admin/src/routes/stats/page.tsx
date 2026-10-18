import { Navigate } from 'react-router-dom';

// The Stats page was folded into the Dashboard (spec §7): the same range
// presets and figures now head /overview. Kept as a redirect for bookmarks.
const StatsRedirect = () => <Navigate to="/overview" replace />;

export default StatsRedirect;
