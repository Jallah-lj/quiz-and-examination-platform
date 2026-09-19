import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { formatDateTime, formatRelative, titleCase } from '../lib/format';
import { knownLink } from '../lib/links';
import { useListState } from '../lib/hooks';
import { useAuth } from '../context/AuthContext';
import type { NotificationRow } from '../types';
import { Badge, Button, Card, PageHeader, Pagination, SelectInput, StatCard, useToast } from '../components/ui';
import { ErrorState } from '../components/StatusPages';

export default function NotificationsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { refresh } = useAuth();
  const list = useListState({ unread: '' });

  const notifications = useQuery({
    queryKey: ['notifications', list.query],
    queryFn: () =>
      api.list<NotificationRow>('/notifications', {
        ...list.query,
        unread: list.filters.unread || undefined,
      }),
  });

  const markAll = useMutation({
    mutationFn: () => api.post('/notifications/read-all'),
    onSuccess: async () => {
      toast.notify('All notifications marked as read.', 'success');
      await queryClient.invalidateQueries({ queryKey: ['notifications'] });
      await refresh();
    },
  });

  const rows = notifications.data?.data ?? [];
  const [openId, setOpenId] = useState<number | null>(null);

  const markRead = async (row: NotificationRow) => {
    if (!row.read_at) {
      await api.post(`/notifications/${row.id}/read`).catch(() => undefined);
      await queryClient.invalidateQueries({ queryKey: ['notifications'] });
      await refresh();
    }
  };

  return (
    <div className="page">
      <PageHeader
        title="Notifications"
        description="Rule-based notifications about examinations, grading, results and your account."
        actions={
          <Button onClick={() => markAll.mutate()} loading={markAll.isPending}>
            Mark all as read
          </Button>
        }
      />

      <div className="stat-grid stat-grid--compact">
        <StatCard label="Notifications" value={notifications.data?.meta.total ?? 0} />
        <StatCard label="Unread on this page" value={rows.filter((row) => !row.read_at).length} tone={rows.some((row) => !row.read_at) ? 'warning' : 'neutral'} />
      </div>

      <Card flush>
        <div className="filter-bar">
          <SelectInput
            wrapperClassName="filter-bar__field"
            placeholder="All notifications"
            options={[{ value: 'true', label: 'Unread only' }]}
            value={list.filters.unread}
            onChange={(event) => list.updateFilter('unread', event.target.value)}
          />
        </div>

        {notifications.error ? (
          <div className="card__body">
            <ErrorState message="Notifications could not be loaded." onRetry={() => void notifications.refetch()} />
          </div>
        ) : notifications.isLoading ? (
          <p className="text-muted" style={{ padding: 16 }}>
            Loading notifications…
          </p>
        ) : rows.length === 0 ? (
          <div className="empty-state">
            <h3>Nothing to show</h3>
            <p>
              Notifications appear when an examination is assigned or scheduled, when a result is released, and when your
              account changes.
            </p>
          </div>
        ) : (
          <ul className="notification-page-list">
            {rows.map((row) => {
              // Stored links can outlive the route they pointed at, so only offer a link
              // the app can actually open.
              const openLink = knownLink(row.link);
              return (
              <li key={row.id} className={row.read_at ? '' : 'notification-page-list__unread'}>
                <button
                  type="button"
                  className="notification-page-list__button"
                  aria-expanded={openId === row.id}
                  onClick={() => {
                    setOpenId(openId === row.id ? null : row.id);
                    void markRead(row);
                  }}
                >
                  <div>
                    <strong>{row.title}</strong>
                    <span className="text-sm text-muted">
                      {titleCase(row.type)} · {formatDateTime(row.created_at)} ({formatRelative(row.created_at)})
                    </span>
                  </div>
                  {row.read_at ? <Badge tone="outline">Read</Badge> : <Badge tone="info">Unread</Badge>}
                </button>
                {openId === row.id ? (
                  <div className="notification-page-list__body">
                    {row.body ? <p>{row.body}</p> : <p className="text-muted">No further detail was recorded.</p>}
                    {openLink ? (
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() => {
                          navigate(openLink);
                        }}
                      >
                        Open
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </li>
              );
            })}
          </ul>
        )}

        <Pagination
          page={list.page}
          pageSize={list.pageSize}
          total={notifications.data?.meta.total ?? 0}
          totalPages={notifications.data?.meta.totalPages ?? 1}
          onPageChange={list.setPage}
        />
      </Card>
    </div>
  );
}
