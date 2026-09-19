import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { InstitutionDashboardView } from './InstitutionDashboardView';

/**
 * A single institution's dashboard.
 *
 * Platform administrators hold no institution of their own, so inspecting a tenant is a
 * navigation rather than an extra panel bolted onto the platform dashboard: the address
 * identifies the institution, the view survives a refresh, and the link can be shared.
 */
export default function InstitutionDashboardPage() {
  const params = useParams<{ institutionId: string }>();
  const navigate = useNavigate();
  const institutionId = Number(params.institutionId);

  // A malformed address falls back to the institutions list rather than requesting nonsense.
  if (!Number.isInteger(institutionId) || institutionId <= 0) {
    return <Navigate to="/institutions" replace />;
  }

  return <InstitutionDashboardView institutionId={institutionId} onBack={() => navigate('/institutions')} />;
}
