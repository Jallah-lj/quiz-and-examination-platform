import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { ResultDetail } from '../../types';
import { Alert, Loading, PageHeader } from '../../components/ui';
import { ResultBreakdown, ResultSummary } from '../../components/ResultBreakdown';
import { useAuth } from '../../context/AuthContext';

export default function AttemptReviewPage() {
  const { attemptId } = useParams();
  const { user } = useAuth();

  const review = useQuery({
    queryKey: ['attempt', attemptId, 'review'],
    queryFn: () => api.get<ResultDetail>(`/attempts/${attemptId}/review`),
    retry: false,
  });

  if (review.isLoading) return <Loading label="Loading attempt review…" />;

  if (review.error || !review.data) {
    const message =
      review.error instanceof Error && review.error.message
        ? review.error.message
        : 'This attempt could not be reviewed. It may still be in progress, or its result may not have been released.';
    return (
      <div className="page">
        <PageHeader title="Attempt review" breadcrumbs={[{ label: 'My attempts', to: '/my-attempts' }, { label: `#${attemptId}` }]} />
        <Alert tone="warning" title="Review unavailable">
          {message}
        </Alert>
        <Link className="btn" to={user?.role === 'student' ? '/my-attempts' : '/grading'}>
          Back
        </Link>
      </div>
    );
  }

  const { result, breakdown } = review.data;

  return (
    <div className="page">
      <PageHeader
        title={`${result.paperTitle} — attempt review`}
        description={`${result.studentName} (${result.studentCode})${result.className ? ` · ${result.className}` : ''}`}
        breadcrumbs={[
          { label: user?.role === 'student' ? 'My attempts' : 'Attempts', to: user?.role === 'student' ? '/my-attempts' : '/grading' },
          { label: `Attempt #${attemptId}` },
        ]}
      />

      {!result.isPublished ? (
        <Alert tone="info" title="Result not yet released">
          The marks shown here are for examination staff. Candidates cannot see this result until it is published.
        </Alert>
      ) : null}

      <ResultSummary result={result} />
      <ResultBreakdown breakdown={breakdown} />
    </div>
  );
}
