import { Link } from 'react-router-dom';
import { IconShield, IconWarning } from './Icons';

export function NotFoundPage() {
  return (
    <div className="status-page">
      <div className="status-page__code">404</div>
      <h1>Page not found</h1>
      <p>The page you requested does not exist or has been moved.</p>
      <Link className="btn btn--primary" to="/dashboard">
        Return to dashboard
      </Link>
    </div>
  );
}

export function ForbiddenPage() {
  return (
    <div className="status-page">
      <div className="status-page__icon" aria-hidden="true">
        <IconShield size={28} />
      </div>
      <h1>You do not have access to this area</h1>
      <p>
        This section requires a permission that is not granted to your role. If you believe you should have access,
        contact your institution administrator.
      </p>
      <Link className="btn" to="/dashboard">
        Return to dashboard
      </Link>
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="alert alert--danger" role="alert">
      <IconWarning size={17} />
      <div style={{ flex: 1 }}>
        <strong>We could not load this data</strong>
        <p style={{ margin: '4px 0 0' }}>{message}</p>
      </div>
      {onRetry ? (
        <button type="button" className="btn btn--sm" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}
