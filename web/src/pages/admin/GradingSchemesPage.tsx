import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { useAuth } from '../../context/AuthContext';
import type { GradingScheme } from '../../types';
import {
  Alert,
  Badge,
  Button,
  Card,
  DataTable,
  DefinitionList,
  Modal,
  PageHeader,
  StatCard,
  TextInput,
  useToast,
} from '../../components/ui';
import { ErrorState } from '../../components/StatusPages';
import { IconPlus, IconTrash } from '../../components/Icons';

interface Band {
  grade: string;
  min_percentage: string;
  max_percentage: string;
  points: string;
  remark: string;
}

const defaultBands: Band[] = [
  { grade: 'A+', min_percentage: '90', max_percentage: '100', points: '4', remark: 'Outstanding' },
  { grade: 'A', min_percentage: '80', max_percentage: '89.99', points: '4', remark: 'Excellent' },
  { grade: 'B', min_percentage: '70', max_percentage: '79.99', points: '3', remark: 'Very good' },
  { grade: 'C', min_percentage: '60', max_percentage: '69.99', points: '2', remark: 'Good' },
  { grade: 'D', min_percentage: '50', max_percentage: '59.99', points: '1', remark: 'Pass' },
  { grade: 'F', min_percentage: '0', max_percentage: '49.99', points: '0', remark: 'Fail' },
];

export default function GradingSchemesPage() {
  const { hasPermission } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<GradingScheme | 'new' | null>(null);

  const schemes = useQuery({
    queryKey: ['grading-schemes'],
    queryFn: () => api.list<GradingScheme>('/grading-schemes', { pageSize: 50 }),
  });

  const rows = schemes.data?.data ?? [];
  const canManage = hasPermission('grading_scheme.manage');

  return (
    <div className="page">
      <PageHeader
        title="Grading schemes"
        description="Grade bands are configured per institution and applied when a result is finalised. Nothing is hard-coded."
        actions={
          canManage ? (
            <Button variant="primary" onClick={() => setEditing('new')}>
              <IconPlus size={16} /> New scheme
            </Button>
          ) : null
        }
      />

      <div className="stat-grid stat-grid--compact">
        <StatCard label="Schemes" value={rows.length} />
        <StatCard
          label="Default scheme"
          value={rows.find((row) => row.is_default)?.name ?? 'None set'}
          meta={rows.find((row) => row.is_default) ? `Pass mark ${rows.find((row) => row.is_default)?.pass_percentage}%` : undefined}
        />
        <StatCard label="Grade bands configured" value={rows.reduce((sum, row) => sum + row.bands.length, 0)} />
      </div>

      {schemes.error ? <ErrorState message="Grading schemes could not be loaded." onRetry={() => void schemes.refetch()} /> : null}

      <div className="split-2">
        {rows.map((scheme) => (
          <Card
            key={scheme.id}
            title={
              <span>
                {scheme.name} {scheme.is_default ? <Badge tone="info">Default</Badge> : null}
              </span>
            }
            description={scheme.description}
            actions={
              canManage ? (
                <Button size="sm" onClick={() => setEditing(scheme)}>
                  Edit
                </Button>
              ) : null
            }
            flush
          >
            <DefinitionList
              items={[
                { term: 'Pass percentage', description: `${scheme.pass_percentage}%` },
                { term: 'Grade bands', description: scheme.bands.length },
                { term: 'Last updated', description: formatDateTime(scheme.updated_at) },
              ]}
            />
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Grade</th>
                    <th scope="col" className="num">
                      From
                    </th>
                    <th scope="col" className="num">
                      To
                    </th>
                    <th scope="col" className="num">
                      Points
                    </th>
                    <th scope="col">Remark</th>
                  </tr>
                </thead>
                <tbody>
                  {scheme.bands
                    .slice()
                    .sort((a, b) => b.min_percentage - a.min_percentage)
                    .map((band) => (
                      <tr key={`${scheme.id}-${band.grade}`}>
                        <td data-label="Grade">
                          <strong>{band.grade}</strong>
                        </td>
                        <td data-label="From" className="num">
                          {band.min_percentage}%
                        </td>
                        <td data-label="To" className="num">
                          {band.max_percentage}%
                        </td>
                        <td data-label="Points" className="num">
                          {band.points ?? '—'}
                        </td>
                        <td data-label="Remark">{band.remark ?? '—'}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </Card>
        ))}
      </div>

      <Card title="Applying a scheme" flush>
        <DataTable
          rows={rows}
          rowKey={(row) => row.id}
          empty={<p>No grading schemes yet. Create one so results carry a letter grade.</p>}
          columns={[
            { key: 'name', header: 'Scheme', render: (row) => row.name },
            { key: 'default', header: 'Default', render: (row) => (row.is_default ? <Badge tone="info">Default</Badge> : '—') },
            { key: 'pass', header: 'Pass %', align: 'right', render: (row) => `${row.pass_percentage}%` },
            { key: 'bands', header: 'Bands', align: 'right', render: (row) => row.bands.length },
            { key: 'updated', header: 'Updated', render: (row) => formatDateTime(row.updated_at) },
          ]}
        />
      </Card>

      <SchemeModal
        target={editing}
        onClose={() => setEditing(null)}
        onSaved={async () => {
          setEditing(null);
          toast.notify('Grading scheme saved.', 'success');
          await queryClient.invalidateQueries({ queryKey: ['grading-schemes'] });
        }}
      />
    </div>
  );
}

function SchemeModal({
  target,
  onClose,
  onSaved,
}: {
  target: GradingScheme | 'new' | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const isNew = target === 'new';
  const scheme = target && target !== 'new' ? target : null;
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [passPercentage, setPassPercentage] = useState('50');
  const [isDefault, setIsDefault] = useState(false);
  const [bands, setBands] = useState<Band[]>(defaultBands);
  const [error, setError] = useState('');
  const [seededFor, setSeededFor] = useState<string | null>(null);

  const key = isNew ? 'new' : scheme ? String(scheme.id) : null;
  if (key !== seededFor) {
    setSeededFor(key);
    setError('');
    setName(scheme?.name ?? '');
    setDescription(scheme?.description ?? '');
    setPassPercentage(String(scheme?.pass_percentage ?? 50));
    setIsDefault(Boolean(scheme?.is_default));
    setBands(
      scheme?.bands.length
        ? scheme.bands.map((band) => ({
            grade: band.grade,
            min_percentage: String(band.min_percentage),
            max_percentage: String(band.max_percentage),
            points: band.points === null ? '' : String(band.points),
            remark: band.remark ?? '',
          }))
        : defaultBands,
    );
  }

  const updateBand = (index: number, field: keyof Band, value: string) =>
    setBands((current) => current.map((band, position) => (position === index ? { ...band, [field]: value } : band)));

  const overlaps = bands.some((band, index) =>
    bands.some(
      (other, otherIndex) =>
        index !== otherIndex &&
        Number(band.min_percentage) <= Number(other.max_percentage) &&
        Number(other.min_percentage) <= Number(band.max_percentage),
    ),
  );

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        name: name.trim(),
        description: description.trim() || null,
        passPercentage: Number(passPercentage),
        isDefault,
        bands: bands.map((band) => ({
          grade: band.grade.trim(),
          min_percentage: Number(band.min_percentage),
          max_percentage: Number(band.max_percentage),
          points: band.points === '' ? null : Number(band.points),
          remark: band.remark.trim() || null,
        })),
      };
      return isNew ? api.post('/grading-schemes', payload) : api.put(`/grading-schemes/${scheme?.id}`, payload);
    },
    onSuccess: onSaved,
    onError: (caught) => setError(caught instanceof ApiError ? caught.message : 'The scheme could not be saved.'),
  });

  return (
    <Modal
      open={Boolean(target)}
      title={isNew ? 'New grading scheme' : `Edit ${scheme?.name ?? 'scheme'}`}
      onClose={onClose}
      wide
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={!name.trim() || overlaps}
            onClick={() => save.mutate()}
          >
            Save scheme
          </Button>
        </>
      }
    >
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <div className="field-row">
        <TextInput label="Scheme name" required value={name} onChange={(event) => setName(event.target.value)} />
        <TextInput
          label="Pass percentage"
          type="number"
          min={0}
          max={100}
          step={0.5}
          value={passPercentage}
          hint="Used to derive the pass mark for each paper."
          onChange={(event) => setPassPercentage(event.target.value)}
        />
      </div>
      <TextInput label="Description" value={description} onChange={(event) => setDescription(event.target.value)} />
      <label className="checkbox-row">
        <input type="checkbox" checked={isDefault} onChange={(event) => setIsDefault(event.target.checked)} />
        <span>
          Make this the institution default
          <span className="field__hint">Applied to examinations that do not select a scheme.</span>
        </span>
      </label>

      <h3 className="modal-section-title">Grade bands</h3>
      {overlaps ? <Alert tone="danger">Grade bands must not overlap. Adjust the ranges so each percentage falls into exactly one band.</Alert> : null}
      <div className="band-editor">
        {bands.map((band, index) => (
          <div key={index} className="band-editor__row">
            <TextInput label="Grade" value={band.grade} onChange={(event) => updateBand(index, 'grade', event.target.value)} />
            <TextInput
              label="From %"
              type="number"
              min={0}
              max={100}
              step={0.01}
              value={band.min_percentage}
              onChange={(event) => updateBand(index, 'min_percentage', event.target.value)}
            />
            <TextInput
              label="To %"
              type="number"
              min={0}
              max={100}
              step={0.01}
              value={band.max_percentage}
              onChange={(event) => updateBand(index, 'max_percentage', event.target.value)}
            />
            <TextInput label="Points" type="number" min={0} value={band.points} onChange={(event) => updateBand(index, 'points', event.target.value)} />
            <TextInput label="Remark" value={band.remark} onChange={(event) => updateBand(index, 'remark', event.target.value)} />
            <button
              type="button"
              className="icon-button icon-button--danger"
              aria-label={`Remove grade ${band.grade || index + 1}`}
              onClick={() => setBands((current) => current.filter((_, position) => position !== index))}
            >
              <IconTrash size={16} />
            </button>
          </div>
        ))}
      </div>
      <Button
        size="sm"
        onClick={() =>
          setBands((current) => [...current, { grade: '', min_percentage: '0', max_percentage: '0', points: '', remark: '' }])
        }
      >
        <IconPlus size={15} /> Add band
      </Button>
    </Modal>
  );
}
