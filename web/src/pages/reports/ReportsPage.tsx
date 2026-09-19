import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import type { ClassRow, Exam, QuestionBank, ReportTable, Student, Subject } from '../../types';
import {
  Alert,
  Button,
  Card,
  Field,
  PageHeader,
  SelectInput,
  StatCard,
  useToast,
} from '../../components/ui';
import { ErrorState } from '../../components/StatusPages';
import { IconDownload, IconPrint } from '../../components/Icons';

interface ReportDefinition {
  key: string;
  name: string;
  params: string[];
}

const PARAM_LABELS: Record<string, string> = {
  studentId: 'Candidate',
  classId: 'Class',
  subjectId: 'Subject',
  examId: 'Examination',
  questionBankId: 'Question bank',
  from: 'From date',
  to: 'To date',
};

export default function ReportsPage() {
  const toast = useToast();
  const [reportKey, setReportKey] = useState('student-results');
  const [params, setParams] = useState<Record<string, string>>({});
  const [exporting, setExporting] = useState<string | null>(null);

  const catalog = useQuery({
    queryKey: ['reports', 'catalog'],
    queryFn: () => api.get<ReportDefinition[]>('/reports/catalog'),
  });

  const definition = useMemo(
    () => catalog.data?.find((report) => report.key === reportKey),
    [catalog.data, reportKey],
  );

  const students = useQuery({
    queryKey: ['students', 'options'],
    queryFn: () => api.list<Student>('/students', { pageSize: 300, status: 'active' }),
    enabled: Boolean(definition?.params.includes('studentId')),
  });

  const classes = useQuery({
    queryKey: ['classes', 'options'],
    queryFn: () => api.list<ClassRow>('/classes', { pageSize: 200 }),
    enabled: Boolean(definition?.params.some((param) => ['classId'].includes(param))),
  });

  const subjects = useQuery({
    queryKey: ['subjects', 'options'],
    queryFn: () => api.list<Subject>('/subjects', { pageSize: 200 }),
    enabled: Boolean(definition?.params.includes('subjectId')),
  });

  const exams = useQuery({
    queryKey: ['examinations', 'options'],
    queryFn: () => api.list<Exam>('/examinations', { pageSize: 200 }),
    enabled: Boolean(definition?.params.includes('examId')),
  });

  const banks = useQuery({
    queryKey: ['question-banks', 'options'],
    queryFn: () => api.list<QuestionBank>('/question-banks', { pageSize: 200 }),
    enabled: Boolean(definition?.params.includes('questionBankId')),
  });

  const report = useQuery({
    queryKey: ['reports', reportKey, params],
    queryFn: () => api.get<ReportTable>(`/reports/${reportKey}`, { ...params, format: 'json' }),
    enabled: Boolean(reportKey),
    retry: false,
  });

  const exportReport = async (format: 'csv' | 'xlsx' | 'pdf') => {
    setExporting(format);
    try {
      await api.download(`/reports/${reportKey}`, { ...params, format }, `${reportKey}.${format}`);
      toast.notify(`Report exported as ${format.toUpperCase()}.`, 'success');
    } catch (caught) {
      toast.notify(caught instanceof ApiError ? caught.message : 'The export failed.', 'error');
    } finally {
      setExporting(null);
    }
  };

  const rows = report.data?.rows ?? [];

  return (
    <div className="page">
      <PageHeader
        title="Reports"
        description="Every report is generated from live database records. Exports are written to the audit log."
        actions={
          <>
            <Button onClick={() => window.print()}>
              <IconPrint size={16} /> Print
            </Button>
            <Button onClick={() => exportReport('csv')} loading={exporting === 'csv'} disabled={!report.data}>
              <IconDownload size={16} /> CSV
            </Button>
            <Button onClick={() => exportReport('xlsx')} loading={exporting === 'xlsx'} disabled={!report.data}>
              <IconDownload size={16} /> Excel
            </Button>
            <Button variant="primary" onClick={() => exportReport('pdf')} loading={exporting === 'pdf'} disabled={!report.data}>
              <IconDownload size={16} /> PDF
            </Button>
          </>
        }
      />

      {catalog.error ? <ErrorState message="The report catalogue could not be loaded." onRetry={() => void catalog.refetch()} /> : null}

      <Card title="Report selection">
        <div className="field-row">
          <SelectInput
            label="Report"
            value={reportKey}
            options={(catalog.data ?? []).map((entry) => ({ value: entry.key, label: entry.name }))}
            onChange={(event) => {
              setReportKey(event.target.value);
              setParams({});
            }}
          />
          {definition?.params.includes('studentId') ? (
            <SelectInput
              label={PARAM_LABELS.studentId}
              placeholder="All candidates"
              value={params.studentId ?? ''}
              options={(students.data?.data ?? []).map((student) => ({
                value: student.id,
                label: `${student.full_name ?? ''} (${student.student_code})`,
              }))}
              onChange={(event) => setParams((current) => ({ ...current, studentId: event.target.value }))}
            />
          ) : null}
          {definition?.params.includes('classId') ? (
            <SelectInput
              label={PARAM_LABELS.classId}
              placeholder="All classes"
              value={params.classId ?? ''}
              options={(classes.data?.data ?? []).map((row) => ({ value: row.id, label: row.name }))}
              onChange={(event) => setParams((current) => ({ ...current, classId: event.target.value }))}
            />
          ) : null}
          {definition?.params.includes('subjectId') ? (
            <SelectInput
              label={PARAM_LABELS.subjectId}
              placeholder="All subjects"
              value={params.subjectId ?? ''}
              options={(subjects.data?.data ?? []).map((subject) => ({ value: subject.id, label: subject.name }))}
              onChange={(event) => setParams((current) => ({ ...current, subjectId: event.target.value }))}
            />
          ) : null}
        </div>

        <div className="field-row">
          {definition?.params.includes('examId') ? (
            <SelectInput
              label={PARAM_LABELS.examId}
              placeholder="All examinations"
              value={params.examId ?? ''}
              options={(exams.data?.data ?? []).map((exam) => ({ value: exam.id, label: `${exam.name} (${exam.code})` }))}
              onChange={(event) => setParams((current) => ({ ...current, examId: event.target.value }))}
            />
          ) : null}
          {definition?.params.includes('questionBankId') ? (
            <SelectInput
              label={PARAM_LABELS.questionBankId}
              placeholder="All question banks"
              value={params.questionBankId ?? ''}
              options={(banks.data?.data ?? []).map((bank) => ({ value: bank.id, label: bank.name }))}
              onChange={(event) => setParams((current) => ({ ...current, questionBankId: event.target.value }))}
            />
          ) : null}
          {definition?.params.includes('from') ? (
            <Field label={PARAM_LABELS.from} htmlFor="report-from">
              <input
                id="report-from"
                type="date"
                className="input"
                value={params.from ?? ''}
                onChange={(event) => setParams((current) => ({ ...current, from: event.target.value }))}
              />
            </Field>
          ) : null}
          {definition?.params.includes('to') ? (
            <Field label={PARAM_LABELS.to} htmlFor="report-to">
              <input
                id="report-to"
                type="date"
                className="input"
                value={params.to ?? ''}
                onChange={(event) => setParams((current) => ({ ...current, to: event.target.value }))}
              />
            </Field>
          ) : null}
        </div>

        <div className="inline">
          <Button onClick={() => void report.refetch()} loading={report.isFetching}>
            Run report
          </Button>
          <Button variant="ghost" onClick={() => setParams({})}>
            Clear filters
          </Button>
        </div>
      </Card>

      {report.error ? (
        <Alert tone="warning" title="This report could not be generated">
          {report.error instanceof ApiError ? report.error.message : 'Select the required filters and run the report again.'}
        </Alert>
      ) : null}

      {report.data ? (
        <>
          <div className="stat-grid stat-grid--compact">
            <StatCard label="Rows" value={rows.length} />
            <StatCard label="Columns" value={report.data.columns.length} />
            <StatCard label="Generated" value={formatDateTime(report.data.generatedAt)} meta={report.data.generatedBy ? `by ${report.data.generatedBy}` : undefined} />
          </div>

          <Card title={report.data.title} description={report.data.subtitle} flush>
            {rows.length === 0 ? (
              <div className="empty-state">
                <h3>No records match this report</h3>
                <p>Adjust the filters — for example widen the date range — and run the report again.</p>
              </div>
            ) : (
              <div className="table-wrap">
                <table className="data-table responsive report-table">
                  <thead>
                    <tr>
                      {report.data.columns.map((column) => (
                        <th key={column.key} scope="col" className={column.align === 'right' ? 'num' : undefined}>
                          {column.header}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, index) => (
                      <tr key={index}>
                        {report.data.columns.map((column) => (
                          <td
                            key={column.key}
                            data-label={column.header}
                            className={column.align === 'right' ? 'num' : undefined}
                          >
                            {row[column.key] === null || row[column.key] === undefined || row[column.key] === ''
                              ? '—'
                              : String(row[column.key])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      ) : null}
    </div>
  );
}
