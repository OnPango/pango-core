import type { MailMessage } from './mail.service.js';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function invitationEmail(params: {
  to: string;
  organizationName: string;
  inviterName: string;
  roleName: string;
  acceptUrl: string;
  expiresAt: Date;
}): MailMessage {
  const { organizationName, inviterName, roleName, acceptUrl, expiresAt } =
    params;
  const expires = expiresAt.toUTCString();
  const subject = `${inviterName} invited you to join ${organizationName} on Pango`;
  const text = [
    `${inviterName} invited you to join ${organizationName} on Pango as ${roleName}.`,
    '',
    `Accept the invitation: ${acceptUrl}`,
    '',
    `This link expires on ${expires}. If you were not expecting it, ignore this email.`,
  ].join('\n');
  const html = `<p>${escapeHtml(inviterName)} invited you to join <strong>${escapeHtml(organizationName)}</strong> on Pango as <strong>${escapeHtml(roleName)}</strong>.</p>
<p><a href="${escapeHtml(acceptUrl)}">Accept the invitation</a></p>
<p>This link expires on ${escapeHtml(expires)}. If you were not expecting it, ignore this email.</p>`;
  return { to: params.to, subject, html, text };
}

export function emailVerificationEmail(params: {
  to: string;
  name: string;
  organizationName: string;
  verifyUrl: string;
  expiresAt: Date;
}): MailMessage {
  const { name, organizationName, verifyUrl, expiresAt } = params;
  const expires = expiresAt.toUTCString();
  const subject = 'Confirm your email to start using Pango';
  const text = [
    `Hi ${name},`,
    '',
    `Confirm your email to activate ${organizationName} on Pango: ${verifyUrl}`,
    '',
    `This link expires on ${expires}. If you did not sign up, ignore this email.`,
  ].join('\n');
  const html = `<p>Hi ${escapeHtml(name)},</p>
<p>Confirm your email to activate <strong>${escapeHtml(organizationName)}</strong> on Pango.</p>
<p><a href="${escapeHtml(verifyUrl)}">Confirm my email</a></p>
<p>This link expires on ${escapeHtml(expires)}. If you did not sign up, ignore this email.</p>`;
  return { to: params.to, subject, html, text };
}

export function loginCodeEmail(params: {
  to: string;
  name: string;
  organizationName: string;
  code: string;
  expiresInMinutes: number;
}): MailMessage {
  const { name, organizationName, code, expiresInMinutes } = params;
  const subject = `${code} is your Pango login code`;
  const text = [
    `Hi ${name},`,
    '',
    `Use this code to finish logging in to ${organizationName} on Pango: ${code}`,
    '',
    `It expires in ${expiresInMinutes} minutes and works once. If you did not try to log in, change your password: someone knows it.`,
  ].join('\n');
  const html = `<p>Hi ${escapeHtml(name)},</p>
<p>Use this code to finish logging in to <strong>${escapeHtml(organizationName)}</strong> on Pango:</p>
<p style="font-size:28px;font-weight:700;letter-spacing:6px;font-family:monospace">${escapeHtml(code)}</p>
<p>It expires in ${expiresInMinutes} minutes and works once. If you did not try to log in, change your password: someone knows it.</p>`;
  return { to: params.to, subject, html, text };
}
