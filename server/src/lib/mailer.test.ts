/**
 * Outbound email.
 *
 * These tests exercise the module the way the application uses it: the reset and
 * verification links must be *delivered*, and the token must never appear in a log line.
 * The SMTP test runs a real (minimal) SMTP server on a loopback port, so the transport is
 * proven against the wire protocol rather than a mock of itself.
 */
import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  appBaseUrl,
  emailVerificationEmail,
  mailStatus,
  passwordResetEmail,
  sendAccountEmail,
  setMailTransport,
  type MailMessage,
  type MailTransport,
} from './mailer';

afterEach(() => {
  setMailTransport(null);
  vi.restoreAllMocks();
});

/**
 * Reads a quoted-printable body back into text: unwraps soft line breaks, then resolves the
 * `=XX` escapes (which is why `?token=` arrives as `?=\r\ntoken=3D`).
 */
function decodeQuotedPrintable(raw: string): string {
  return raw
    .replace(/=\r\n/g, '')
    .replace(/=([0-9A-F]{2})/gi, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

function capture(): { sent: (MailMessage & { from: string })[]; transport: MailTransport } {
  const sent: (MailMessage & { from: string })[] = [];
  const transport: MailTransport = {
    name: 'capture',
    async send(message) {
      sent.push(message);
    },
  };
  setMailTransport(transport);
  return { sent, transport };
}

describe('account emails', () => {
  it('builds a reset link that carries the token back to the reset screen', () => {
    const message = passwordResetEmail({ fullName: 'Bianca Chen', token: 'tok-abc123' });
    expect(message.subject).toContain('reset');
    expect(message.text).toContain('Bianca Chen');
    expect(message.text).toContain(`${appBaseUrl()}/reset-password?token=tok-abc123`);
    // A reset email must say the link expires and that ignoring it is safe.
    expect(message.text).toMatch(/expires in 2 hours/i);
    expect(message.text).toMatch(/did not request/i);
  });

  it('builds a verification link, escaping tokens that need it', () => {
    const message = emailVerificationEmail({ fullName: 'Aaron Boateng', token: 'a/b+c=' });
    expect(message.text).toContain(`${appBaseUrl()}/verify-email?token=a%2Fb%2Bc%3D`);
  });

  it('sends the reset link and reports delivery', async () => {
    const { sent } = capture();
    const result = await sendAccountEmail({
      to: 'student@northgate.edu',
      fullName: 'Imani Duarte',
      template: 'password-reset',
      token: 'tok-xyz',
    });
    expect(result.delivered).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('student@northgate.edu');
    expect(sent[0].text).toContain('token=tok-xyz');
  });

  it('reports a delivery failure instead of throwing, and never logs the token', async () => {
    const logged: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...args) => {
      logged.push(args.map(String).join(' '));
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    setMailTransport({
      name: 'broken',
      async send() {
        throw new Error('relay refused the connection');
      },
    });

    const result = await sendAccountEmail({
      to: 'student@northgate.edu',
      fullName: 'Imani Duarte',
      template: 'password-reset',
      token: 'tok-secret-value',
    });
    expect(result.delivered).toBe(false);
    expect(result.error).toContain('relay refused');
    // The failure reason is useful to an administrator; the token is not theirs to see.
    const everything = [...logged].join('\n');
    expect(everything).not.toContain('tok-secret-value');
    log.mockRestore();
    warn.mockRestore();
    error.mockRestore();
  });

  it('writes messages to a development outbox when no mail server is configured', async () => {
    setMailTransport(null);
    const status = mailStatus();
    expect(status.transport.startsWith('outbox:') || status.transport.startsWith('smtp:')).toBe(true);
    if (!process.env.SMTP_HOST) {
      expect(status.deliveryConfigured).toBe(false);
    }
  });
});

describe('SMTP delivery', () => {
  it('delivers a reset link over a real SMTP conversation', async () => {
    const received: string[] = [];
    const server = net.createServer((socket) => {
      socket.write('220 mail.test ESMTP\r\n');
      socket.on('data', (chunk) => {
        const text = chunk.toString();
        received.push(text);
        if (/^EHLO|^HELO/im.test(text)) socket.write('250 mail.test\r\n');
        else if (/^MAIL FROM/im.test(text)) socket.write('250 OK\r\n');
        else if (/^RCPT TO/im.test(text)) socket.write('250 OK\r\n');
        else if (/^DATA/im.test(text)) socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        else if (/\r\n\.\r\n$/.test(text)) socket.write('250 Queued\r\n');
        else if (/^QUIT/im.test(text)) {
          socket.write('221 Bye\r\n');
          socket.end();
        } else socket.write('250 OK\r\n');
      });
    });

    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
    });

    try {
      // Point the module at the test relay through the environment, exactly as an operator would.
      process.env.SMTP_HOST = '127.0.0.1';
      process.env.SMTP_PORT = String(port);
      process.env.SMTP_SECURE = 'false';
      process.env.SMTP_FROM = 'no-reply@examsys.test';
      vi.resetModules();
      const fresh = await import('./mailer');
      fresh.setMailTransport(null);

      const result = await fresh.sendAccountEmail({
        to: 'candidate@northgate.edu',
        fullName: 'Grace Mensah',
        template: 'password-reset',
        token: 'tok-over-smtp',
      });

      expect(result.delivered).toBe(true);
      const conversation = received.join('\n');
      expect(conversation).toContain('MAIL FROM');
      expect(conversation).toContain('RCPT TO:<candidate@northgate.edu>');
      // The message body really crossed the wire, link and all.
      const decoded = decodeQuotedPrintable(conversation);
      expect(decoded).toContain('Subject: ExamSys: reset your password');
      expect(decoded).toContain('/reset-password?token=tok-over-smtp');
      expect(decoded).toContain('expires in 2 hours');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      delete process.env.SMTP_HOST;
      delete process.env.SMTP_PORT;
      delete process.env.SMTP_SECURE;
      delete process.env.SMTP_FROM;
      vi.resetModules();
    }
  });
});
