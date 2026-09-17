/**
 * The account menu.
 *
 * It is the only place the signed-in identity is shown on a phone, so the name, the email
 * and the role each have to stay on their own line — the header previously ran them
 * together ("Dr. Amelia Hartdemo.admin@northgate.edu") because the email was an inline
 * span beside the name.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AppLayout } from './AppLayout';
import { ToastProvider } from './ui';
import { ThemeProvider } from '../context/ThemeContext';

const signOut = vi.fn();

const account = {
  id: 2,
  fullName: 'Dr. Amelia Hart',
  email: 'demo.admin@northgate.edu',
  role: 'institution_admin' as const,
  roleName: 'Institution Administrator',
  institution: { id: 2, name: 'Northgate Institute of Technology' },
};

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: account,
    hasPermission: () => true,
    unreadNotifications: 3,
    logout: signOut,
    refresh: async () => undefined,
    unreadCount: 3,
  }),
}));

const cssPath = ['src/styles/app.css', 'web/src/styles/app.css']
  .map((candidate) => resolve(process.cwd(), candidate))
  .find((candidate) => existsSync(candidate));
if (!cssPath) throw new Error('Could not locate styles/app.css for the menu audit');
const css = readFileSync(cssPath, 'utf8');

function renderShell() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <ToastProvider>
          <MemoryRouter initialEntries={['/dashboard']}>
            <AppLayout />
          </MemoryRouter>
        </ToastProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

describe('account menu', () => {
  beforeEach(() => {
    localStorage.clear();
    signOut.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the identity on separate lines and offers the account actions', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } })));
    renderShell();

    await user.click(screen.getByRole('button', { name: 'Account menu for Dr. Amelia Hart' }));

    const menu = screen.getByRole('dialog', { name: 'Account menu' });
    // The name, the address and the role are three separate elements, never one run-on line.
    const identity = menu.querySelector('.account-popover__identity') as HTMLElement;
    expect(within(identity).getByText('Dr. Amelia Hart')).toBeInTheDocument();
    const email = within(identity).getByText('demo.admin@northgate.edu');
    expect(email.className).toContain('account-popover__email');
    expect(within(identity).getByText('Institution Administrator')).toBeInTheDocument();

    // Each part is its own element inside a column, which is what keeps them on separate
    // lines; the old header left the email as an inline span beside the name.
    expect(identity.querySelector('.menu-popover__header')).toBeNull();
    expect(css).toMatch(/\.account-popover__identity-text \{[^}]*flex-direction: column/);
    // Long values are truncated in CSS rather than allowed to overflow the panel.
    expect(css).toMatch(/\.account-popover__email \{[^}]*text-overflow: ellipsis/);
    expect(css).toMatch(/\.account-popover__identity-text strong \{[^}]*white-space: nowrap/);

    // Actions, the appearance choice and the sign-out row.
    expect(within(menu).getByRole('button', { name: /Profile & password/ })).toBeInTheDocument();
    const notifications = within(menu).getByRole('button', { name: /Notifications/ });
    expect(within(notifications).getByText('3')).toBeInTheDocument();
    expect(within(menu).getByRole('group', { name: 'Appearance' })).toBeInTheDocument();
    await user.click(within(menu).getByRole('button', { name: /Sign out/ }));
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('announces the menu state and marks the open panel for the theme', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } })));
    renderShell();

    const trigger = screen.getByRole('button', { name: 'Account menu for Dr. Amelia Hart' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(trigger.querySelector('.account-button__chevron')).not.toBeNull();
    // The chevron turns over when the menu opens instead of pointing the wrong way.
    expect(css).toMatch(/\.account-button\[aria-expanded='true'\] \.account-button__chevron \{ transform: rotate\(180deg\)/);
  });

  it('keeps the rows inset so tints stop short of the border', () => {
    // A padded panel with rounded rows is what stops the hover tint bleeding to the edges.
    expect(css).toMatch(/\.menu-popover--account \{[^}]*padding: 0\.4rem/);
    expect(css).toMatch(/\.menu-item \{[^}]*border-radius: var\(--radius\)/);
  });
});
