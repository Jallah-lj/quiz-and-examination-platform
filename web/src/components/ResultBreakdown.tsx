import { Badge, Card, DefinitionList, StatCard, StatusBadge } from './ui';
import { formatDateTime, formatMark, formatPercentage, titleCase } from '../lib/format';
import { QUESTION_TYPE_LABELS, type ResultDetail } from '../types';

/**
 * Shared result view used by the candidate review page, the examiner review page and
 * the result detail screen. Marks, breakdown visibility and correct answers are all
 * decided by the server; this component only renders what it receives.
 */
export function ResultSummary({ result }: { result: ResultDetail['result'] }) {
  return (
    <>
      <div className="stat-grid stat-grid--compact">
        <StatCard
          label="Score"
          value={`${formatMark(result.obtainedMarks)} / ${formatMark(result.totalMarks)}`}
          meta={formatPercentage(result.percentage)}
          tone={result.outcome === 'PASSED' ? 'success' : result.outcome === 'FAILED' ? 'danger' : 'warning'}
        />
        <StatCard label="Grade" value={result.grade ?? '—'} meta={result.outcome === 'PENDING' ? 'Marking in progress' : undefined} />
        <StatCard
          label="Objective marks"
          value={result.objectiveMarks === null ? '—' : formatMark(result.objectiveMarks)}
          meta={result.subjectiveMarks ? `${formatMark(result.subjectiveMarks)} from written answers` : undefined}
        />
        <StatCard
          label="Pass mark"
          value={result.passMarks === null ? '—' : formatMark(result.passMarks)}
          meta={result.outcome === 'PENDING' ? 'Awaiting examiner' : undefined}
        />
        <StatCard label="Submitted" value={formatDateTime(result.submittedAt)} meta={result.autoSubmitted ? 'Auto-submitted on expiry' : undefined} />
        <StatCard
          label="Result status"
          value={result.isPublished ? <Badge tone="success" size="lg">Released</Badge> : <Badge tone="outline" size="lg">Withheld</Badge>}
          meta={result.publishedAt ? formatDateTime(result.publishedAt) : undefined}
        />
      </div>

      <div className="split-2">
        <Card title="Paper details">
          <DefinitionList
            items={[
              { term: 'Assessment', description: `${result.paperTitle}${result.paperCode ? ` (${result.paperCode})` : ''}` },
              { term: 'Type', description: result.kind === 'EXAM' ? `${titleCase(result.examType ?? 'Examination')}` : 'Quiz' },
              { term: 'Subject', description: result.subjectName ?? '—' },
              { term: 'Candidate', description: `${result.studentName} (${result.studentCode})` },
              { term: 'Class', description: result.className ?? '—' },
              { term: 'Academic period', description: [result.academicYear, result.semester].filter(Boolean).join(' · ') || '—' },
              { term: 'Examiner', description: result.examinerName ?? 'Not yet assigned' },
              { term: 'Attempt status', description: <StatusBadge status={result.attemptStatus} /> },
            ]}
          />
        </Card>

        <Card title="Integrity signals">
          {result.integrityFlags.length === 0 ? (
            <p className="text-muted">
              No integrity events were recorded during this attempt. Invigilation signals are indicators, not proof.
            </p>
          ) : (
            <ul className="flag-list">
              {result.integrityFlags.map((flag, index) => (
                <li key={`${flag.type}-${index}`}>
                  <Badge tone="warning">{flag.type.replace(/_/g, ' ')}</Badge>
                  <span>{flag.detail}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}

export function ResultBreakdown({ breakdown }: { breakdown: ResultDetail['breakdown'] }) {
  if (!breakdown.length) {
    return (
      <Card title="Answer breakdown">
        <p className="text-muted">
          The detailed breakdown is not available for this paper. The examiner may have disabled review, or the result is
          still being marked.
        </p>
      </Card>
    );
  }

  return (
    <Card title="Answer breakdown" description="Marks shown per question, including any manual marks and examiner comments." flush>
      <ol className="breakdown">
        {breakdown.map((item) => {
          const correctLabels = new Set(
            ((item.correctAnswer?.correctOptions as string[] | undefined) ?? []).map((label) => label.toUpperCase()),
          );
          return (
            <li key={item.questionId} className="breakdown__item">
              <div className="breakdown__head">
                <span className="breakdown__position">Q{item.position}</span>
                <Badge tone="outline">{QUESTION_TYPE_LABELS[item.type]}</Badge>
                <span className="breakdown__marks">
                  {item.awardedMarks === null ? 'Not marked' : `${formatMark(item.awardedMarks)} / ${formatMark(item.marks)}`}
                </span>
                {item.isCorrect === true ? (
                  <Badge tone="success">Correct</Badge>
                ) : item.isCorrect === false ? (
                  <Badge tone="danger">Incorrect</Badge>
                ) : (
                  <Badge tone="outline">Manually marked</Badge>
                )}
              </div>
              <p className="breakdown__text">{item.text}</p>

              {item.options.length ? (
                <ul className="option-list option-list--review">
                  {item.options.map((option) => {
                    const chosen = item.selectedOptions.includes(option.label);
                    const correct = correctLabels.has(option.label.toUpperCase());
                    return (
                      <li
                        key={option.label}
                        className={['option', chosen ? 'option--selected' : '', correct ? 'option--correct' : ''].filter(Boolean).join(' ')}
                      >
                        <span className="option__label">{option.label}</span>
                        <span className="option__text">{option.text}</span>
                        <span className="option__flags">
                          {chosen ? <span className="option__flag">Chosen</span> : null}
                          {correct ? <span className="option__flag option__flag--correct">Correct</span> : null}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="breakdown__answer">
                  <h4>Candidate answer</h4>
                  <p>{item.answerText?.trim() ? item.answerText : <span className="text-muted">No answer was given.</span>}</p>
                </div>
              )}

              {item.comment ? (
                <div className="breakdown__comment">
                  <h4>Examiner comment</h4>
                  <p>{item.comment}</p>
                </div>
              ) : null}

              {item.explanation ? (
                <div className="breakdown__explanation">
                  <h4>Explanation</h4>
                  <p>{item.explanation}</p>
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
