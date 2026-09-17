import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import type { ResultDetail } from '../../types';
import { Alert, Loading, PageHeader } from '../../components/ui';
import { ErrorState } from '../../components/StatusPages';
import { ResultBreakdown, ResultSummary } from '../../components/ResultBreakdown';

export default function ResultDetailPage() {
  const { resultId } = useParams();
  const { user } = useAuth();

  const detail = useQuery({
    queryKey: ['result', resultId],
    queryFn: () => api.get<ResultDetail>(`/results/${resultId}`),
    retry: false,
  });

  if (detail.isLoading) return <Loading label="Loading result…" />;
  if (detail.error || !detail.data) {
    return <ErrorState message="This result could not be loaded. It may not be released yet, or it belongs to another candidate." onRetry={() => void detail.refetch()} />;
  }

  const { result, breakdown } = detail.data;
  const isStaff = user?.role !== 'student';

  return (
    <div className="page">
      <PageHeader
        title={result.paperTitle}
        description={`${result.studentName} (${result.studentCode})${result.className ? ` · ${result.className}` : ''} · ${result.subjectName ?? ''}`}
        breadcrumbs={[{ label: 'Results', to: '/results' }, { label: result.paperCode || `Result #${result.id}` }]}
      />

      {!result.isPublished ? (
        <Alert tone="info" title="This result has not been released">
          {isStaff
            ? 'Candidates cannot see this result until it is published from the results list or examination page.'
            : 'It will become visible once your institution releases it.'}
        </Alert>
      ) : null}

      <ResultSummary result={result} />
      <ResultBreakdown breakdown={breakdown} />
    </div>
  );
}
