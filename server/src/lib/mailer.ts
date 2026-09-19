/**
 * Outbound email.
 *
 * Two flows genuinely depend on delivery — password reset and address verification — because
 * the token that completes them is only ever held by the account owner. Until this module
 * existed, those tokens were generated and returned in the API response, so outside
 * development nobody could ever complete either flow.
 *
 * Transport is chosen from the environment:
 *
 *  - `SMTP_HOST` set  → real delivery through SMTP (required in production).
 *  - otherwise, dev   → messages are written to `data/outbox/` as `.eml` files, and the
 *                       server log records only the file path. A development machine has no
 *                       mail server, but the message must still be openable end to end.
 *  - otherwise, prod  → sending fails loudly. Quietly discarding a reset link would look
 *                       like a working feature while locking every user out.
 *
 * Tokens, links and passwords are never logged. `SMTP_*` values come from the environment
 * only — nothing here is ever hard-coded or committed.
 */
import fs from 'node:fs';
import path from 'node:path';
import nodemailer, { type Transporter } from 'nodemailer';
import { env, rootDirectory } from '../config/env';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface MailTransport {
  readonly name: string;
  send(message: MailMessage & { from: string }): Promise<void>;
}

let cached: MailTransport | null = null;

/** Development transport: one readable file per message, no data leaves the machine. */
function outboxTransport(directory: string): MailTransport {
  return {
    name: `outbox:${directory}`,
    async send(message) {
      await fs.promises.mkdir(directory, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const safeTo = message.to.replace(/[^a-zA-Z0-9._@-]/g, '_');
      const file = path.join(directory, `${stamp}-${safeTo}.eml`);
      const headers = [
        `From: ${message.from}`,
        `To: ${message.to}`,
        `Subject: ${message.subject}`,
        `Date: ${new Date().toUTCString()}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        '',
      ].join('\n');
      await fs.promises.writeFile(file, `${headers}${message.text}\n`, { mode: 0o600 });
      // The path is safe to log: it carries the recipient and time, never the token.
      // eslint-disable-next-line no-console
      console.log(`[mail] wrote message for ${message.to} to ${file}`);
    },
  };
}

function smtpTransport(): MailTransport {
  const transporter: Transporter = nodemailer.createTransport({
    host: env.smtp.host,
    port: env.smtp.port,
    secure: env.smtp.secure,
    auth: env.smtp.user ? { user: env.smtp.user, pass: env.smtp.pass } : undefined,
    // A bounded attempt: a slow relay must not hold a request open indefinitely.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return {
    name: `smtp:${env.smtp.host}:${env.smtp.port}`,
    async send(message) {
      await transporter.sendMail({
        from: message.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
    },
  };
}

export function mailTransport(): MailTransport {
  if (cached) return cached;
  if (env.smtp.host) cached = smtpTransport();
  else if (env.isProd) {
    cached = {
      name: 'unconfigured',
      async send() {
        throw new Error(
          'Outbound email is not configured. Set SMTP_HOST (and SMTP_FROM) so account emails can be delivered.',
        );
      },
    };
  } else cached = outboxTransport(path.join(rootDirectory, 'data', 'outbox'));
  return cached;
}

/** Describes delivery for the startup log and the system-info endpoint. */
export function mailStatus(): { transport: string; deliveryConfigured: boolean; from: string } {
  const transport = mailTransport();
  return {
    transport: transport.name,
    deliveryConfigured: transport.name.startsWith('smtp:'),
    from: env.smtp.from,
  };
}

/** Test seam: inject a transport, or pass null to drop the cached one. */
export function setMailTransport(transport: MailTransport | null): void {
  cached = transport;
}

/**
 * The application's own address, used to build links that come back to it. Falls back to the
 * first configured CORS origin, then to the SPA's development port.
 */
export function appBaseUrl(): string {
  if (env.appBaseUrl) return env.appBaseUrl.replace(/\/$/, '');
  if (env.corsOrigins.length) return env.corsOrigins[0].replace(/\/$/, '');
  return `http://localhost:${env.webDevPort}`;
}

export function passwordResetEmail(input: { fullName: string; token: string }): MailMessage {
  const link = `${appBaseUrl()}/reset-password?token=${encodeURIComponent(input.token)}`;
  return {
    to: '',
    subject: `${env.appName}: reset your password`,
    text: [
      `Hello ${input.fullName},`,
      '',
      'A password reset was requested for your account. Open the link below to choose a new password:',
      '',
      link,
      '',
      'The link can be used once and expires in 2 hours. If you did not request it, no action is',
      'needed — your current password stays unchanged.',
      '',
      `— ${env.appName}`,
    ].join('\n'),
  };
}

export function emailVerificationEmail(input: { fullName: string; token: string }): MailMessage {
  const link = `${appBaseUrl()}/verify-email?token=${encodeURIComponent(input.token)}`;
  return {
    to: '',
    subject: `${env.appName}: confirm your email address`,
    text: [
      `Hello ${input.fullName},`,
      '',
      'Confirm this address to finish setting up your account:',
      '',
      link,
      '',
      'If you did not create an account, you can ignore this message.',
      '',
      `— ${env.appName}`,
    ].join('\n'),
  };
}

/**
 * Sends an account email and reports whether it left the building. Callers record the
 * outcome in the audit log, so a delivery failure is visible to administrators instead of
 * silently stranding the account.
 */
export async function sendAccountEmail(input: {
  to: string;
  fullName: string;
  template: 'password-reset' | 'email-verification';
  token: string;
}): Promise<{ delivered: boolean; error?: string }> {
  const message = input.template === 'password-reset' ? passwordResetEmail(input) : emailVerificationEmail(input);
  try {
    await mailTransport().send({ ...message, to: input.to, from: env.smtp.from });
    return { delivered: true };
  } catch (error) {
    // The token must never reach the log; only the reason for the failure does.
    return { delivered: false, error: error instanceof Error ? error.message : 'Unknown delivery error' };
  }
}
