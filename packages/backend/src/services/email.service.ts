// packages/backend/src/services/email.service.ts

import sgMail from '@sendgrid/mail';

// Initialize SendGrid
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY!;
const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || 'djl@ctxbridge.io';
const FROM_NAME = process.env.SENDGRID_FROM_NAME || 'ContextBridge';

// Base URL for links in emails
const BASE_URL = process.env.NODE_ENV === 'production' 
  ? 'https://ctxbridge.io' 
  : 'http://localhost:5173';

if (SENDGRID_API_KEY) {
  sgMail.setApiKey(SENDGRID_API_KEY);
} else {
  console.warn('SENDGRID_API_KEY not set - emails will not be sent');
}

interface EmailOptions {
  to: string;
  subject: string;
  text: string;
  html: string;
}

async function sendEmail(options: EmailOptions): Promise<boolean> {
  if (!SENDGRID_API_KEY) {
    console.log('[Email] Would send email:', options.subject, 'to', options.to);
    return true; // Pretend success in dev without key
  }

  try {
    await sgMail.send({
      to: options.to,
      from: {
        email: FROM_EMAIL,
        name: FROM_NAME
      },
      subject: options.subject,
      text: options.text,
      html: options.html
    });
    console.log('[Email] Sent:', options.subject, 'to', options.to);
    return true;
  } catch (error: any) {
    console.error('[Email] Failed to send:', error.response?.body || error.message);
    return false;
  }
}

export async function sendVerificationEmail(
  email: string, 
  token: string, 
  name?: string
): Promise<boolean> {
  const verifyUrl = `${BASE_URL}/verify-email?token=${token}`;
  const greeting = name ? `Hi ${name}` : 'Hi';

  return sendEmail({
    to: email,
    subject: 'Verify your ContextBridge account',
    text: `${greeting},

Welcome to ContextBridge! Please verify your email address by clicking the link below:

${verifyUrl}

This link will expire in 24 hours.

If you didn't create an account, you can safely ignore this email.

— The ContextBridge Team`,
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #333;">${greeting},</h2>
        <p>Welcome to ContextBridge! Please verify your email address by clicking the button below:</p>
        <p style="margin: 30px 0;">
          <a href="${verifyUrl}" 
             style="background: #4F46E5; color: white; padding: 12px 24px; 
                    text-decoration: none; border-radius: 6px; display: inline-block;">
            Verify Email Address
          </a>
        </p>
        <p style="color: #666; font-size: 14px;">
          Or copy and paste this link: <br>
          <a href="${verifyUrl}" style="color: #4F46E5;">${verifyUrl}</a>
        </p>
        <p style="color: #666; font-size: 14px;">This link will expire in 24 hours.</p>
        <p style="color: #666; font-size: 14px;">
          If you didn't create an account, you can safely ignore this email.
        </p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
        <p style="color: #999; font-size: 12px;">— The ContextBridge Team</p>
      </div>
    `
  });
}

export async function sendPasswordResetEmail(
  email: string, 
  token: string,
  name?: string
): Promise<boolean> {
  const resetUrl = `${BASE_URL}/reset-password?token=${token}`;
  const greeting = name ? `Hi ${name}` : 'Hi';

  return sendEmail({
    to: email,
    subject: 'Reset your ContextBridge password',
    text: `${greeting},

We received a request to reset your password. Click the link below to choose a new password:

${resetUrl}

This link will expire in 1 hour.

If you didn't request a password reset, you can safely ignore this email.

— The ContextBridge Team`,
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #333;">${greeting},</h2>
        <p>We received a request to reset your password. Click the button below to choose a new password:</p>
        <p style="margin: 30px 0;">
          <a href="${resetUrl}" 
             style="background: #4F46E5; color: white; padding: 12px 24px; 
                    text-decoration: none; border-radius: 6px; display: inline-block;">
            Reset Password
          </a>
        </p>
        <p style="color: #666; font-size: 14px;">
          Or copy and paste this link: <br>
          <a href="${resetUrl}" style="color: #4F46E5;">${resetUrl}</a>
        </p>
        <p style="color: #666; font-size: 14px;">This link will expire in 1 hour.</p>
        <p style="color: #666; font-size: 14px;">
          If you didn't request a password reset, you can safely ignore this email.
        </p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
        <p style="color: #999; font-size: 12px;">— The ContextBridge Team</p>
      </div>
    `
  });
}