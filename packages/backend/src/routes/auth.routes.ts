// packages/backend/src/routes/auth.routes.ts
import { Router, Request, Response } from 'express';
import { SupabaseClient } from '@supabase/supabase-js';
import {
  hashPassword,
  verifyPassword,
  generateTokenPair,
  generateRandomToken,
  getVerificationExpiry,
  getPasswordResetExpiry,
  verifyRefreshToken,
  hashToken,
  verifyTokenHash
} from '../services/auth.service';
import {
  sendVerificationEmail,
  sendPasswordResetEmail
} from '../services/email.service';
import { requireAuth } from '../middleware/auth.middleware';

export function createAuthRoutes(supabase: SupabaseClient) {
  const router = Router();

  // POST /auth/register
  router.post('/register', async (req: Request, res: Response) => {
    try {
      const { email, password, name } = req.body;

      // Validation
      if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
      }

      if (password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
      }

      const normalizedEmail = email.toLowerCase().trim();

      // Check if user already exists
      const { data: existingUser } = await supabase
        .from('cb_users')
        .select('id')
        .eq('email', normalizedEmail)
        .single();

      if (existingUser) {
        return res.status(409).json({ error: 'An account with this email already exists' });
      }

      // Hash password and generate verification token
      const passwordHash = await hashPassword(password);
      const verificationToken = generateRandomToken();
      const verificationExpires = getVerificationExpiry();

      // Create user
      const { data: newUser, error: createError } = await supabase
        .from('cb_users')
        .insert({
          email: normalizedEmail,
          name: name || null,
          password_hash: passwordHash,
          email_verified: false,
          email_verification_token: verificationToken,
          email_verification_expires: verificationExpires.toISOString()
        })
        .select('id, email, name')
        .single();

      if (createError) {
        console.error('[Auth] Registration error:', createError);
        return res.status(500).json({ error: 'Failed to create account' });
      }

      // Send verification email
      await sendVerificationEmail(normalizedEmail, verificationToken, name);

      console.log('[Auth] User registered:', normalizedEmail);

      res.status(201).json({
        message: 'Account created. Please check your email to verify your account.',
        user: {
          id: newUser.id,
          email: newUser.email,
          name: newUser.name
        }
      });
    } catch (error: any) {
      console.error('[Auth] Registration error:', error);
      res.status(500).json({ error: 'Registration failed' });
    }
  });

  // POST /auth/login
  router.post('/login', async (req: Request, res: Response) => {
    try {
      const { email, password } = req.body;

      if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
      }

      // Normalize email
      const normalizedEmail = email.toLowerCase().trim();

      // Find user
      const { data: user, error: findError } = await supabase
      .from('cb_users')
      .select('id, email, name, password_hash, email_verified, is_admin')
      .eq('email', normalizedEmail)
      .single();

      if (findError || !user) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      // Verify password
      const passwordValid = await verifyPassword(password, user.password_hash);
      if (!passwordValid) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      // Check if email is verified
      if (!user.email_verified) {
        return res.status(403).json({ 
          error: 'Please verify your email before logging in',
          code: 'EMAIL_NOT_VERIFIED'
        });
      }

      // Generate tokens
      const tokens = generateTokenPair({ userId: user.id, email: user.email });

      // Store refresh token hash
      const refreshTokenHash = await hashToken(tokens.refreshToken);
      const refreshExpiry = new Date();
      refreshExpiry.setDate(refreshExpiry.getDate() + 7); // 7 days

      await supabase
        .from('cb_refresh_tokens')
        .insert({
          user_id: user.id,
          token_hash: refreshTokenHash,
          expires_at: refreshExpiry.toISOString()
        });

      // Update last login
      await supabase
        .from('cb_users')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', user.id);

      console.log('[Auth] User logged in:', normalizedEmail);

      res.json({
        message: 'Login successful',
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          is_admin: user.is_admin || false
        },
        tokens
      });
    } catch (error: any) {
      console.error('[Auth] Login error:', error);
      res.status(500).json({ error: 'Login failed' });
    }
  });

  // POST /auth/verify-email
  router.post('/verify-email', async (req: Request, res: Response) => {
    try {
      const { token } = req.body;

      if (!token) {
        return res.status(400).json({ error: 'Verification token is required' });
      }

      // Find user with this token
      const { data: user, error: findError } = await supabase
        .from('cb_users')
        .select('id, email, email_verification_expires')
        .eq('email_verification_token', token)
        .single();

      if (findError || !user) {
        return res.status(400).json({ error: 'Invalid or expired verification token' });
      }

      // Check if token has expired
      if (new Date(user.email_verification_expires) < new Date()) {
        return res.status(400).json({ error: 'Verification token has expired' });
      }

      // Mark email as verified
      const { error: updateError } = await supabase
        .from('cb_users')
        .update({
          email_verified: true,
          email_verification_token: null,
          email_verification_expires: null,
          updated_at: new Date().toISOString()
        })
        .eq('id', user.id);

      if (updateError) {
        console.error('[Auth] Verification update error:', updateError);
        return res.status(500).json({ error: 'Failed to verify email' });
      }

      console.log('[Auth] Email verified:', user.email);

      res.json({ message: 'Email verified successfully. You can now log in.' });
    } catch (error: any) {
      console.error('[Auth] Verification error:', error);
      res.status(500).json({ error: 'Verification failed' });
    }
  });

  // POST /auth/resend-verification
  router.post('/resend-verification', async (req: Request, res: Response) => {
    try {
      const { email } = req.body;

      if (!email) {
        return res.status(400).json({ error: 'Email is required' });
      }

      const normalizedEmail = email.toLowerCase().trim();

      // Find user
      const { data: user, error: findError } = await supabase
        .from('cb_users')
        .select('id, name, email_verified')
        .eq('email', normalizedEmail)
        .single();

      // Always return success to prevent email enumeration
      const successMessage = 'If an unverified account with that email exists, a verification link has been sent.';

      if (!user) {
        console.log('[Auth] Resend verification requested for non-existent email:', normalizedEmail);
        return res.json({ message: successMessage });
      }

      if (user.email_verified) {
        console.log('[Auth] Resend verification requested for already verified email:', normalizedEmail);
        return res.json({ message: successMessage });
      }

      // Generate new verification token
      const verificationToken = generateRandomToken();
      const verificationExpires = getVerificationExpiry();

      // Update user with new token
      await supabase
        .from('cb_users')
        .update({
          email_verification_token: verificationToken,
          email_verification_expires: verificationExpires.toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('id', user.id);

      // Send verification email
      await sendVerificationEmail(normalizedEmail, verificationToken, user.name);

      console.log('[Auth] Verification email resent to:', normalizedEmail);

      res.json({ message: successMessage });
    } catch (error: any) {
      console.error('[Auth] Resend verification error:', error);
      res.status(500).json({ error: 'Failed to resend verification email' });
    }
  });

  // POST /auth/refresh
  router.post('/refresh', async (req: Request, res: Response) => {
    try {
      const { refreshToken } = req.body;

      if (!refreshToken) {
        return res.status(400).json({ error: 'Refresh token is required' });
      }

      // Verify the refresh token JWT
      let payload;
      try {
        payload = verifyRefreshToken(refreshToken);
      } catch (err) {
        return res.status(401).json({ error: 'Invalid or expired refresh token' });
      }

      // Find stored refresh tokens for this user
      const { data: storedTokens, error: findError } = await supabase
        .from('cb_refresh_tokens')
        .select('id, token_hash, expires_at')
        .eq('user_id', payload.userId)
        .gt('expires_at', new Date().toISOString());

      if (findError || !storedTokens || storedTokens.length === 0) {
        return res.status(401).json({ error: 'Refresh token not found or expired' });
      }

      // Check if the provided token matches any stored hash
      let matchedTokenId: string | null = null;
      for (const stored of storedTokens) {
        const isMatch = await verifyTokenHash(refreshToken, stored.token_hash);
        if (isMatch) {
          matchedTokenId = stored.id;
          break;
        }
      }

      if (!matchedTokenId) {
        return res.status(401).json({ error: 'Invalid refresh token' });
      }

      // Get user info
      const { data: user } = await supabase
        .from('cb_users')
        .select('id, email, name')
        .eq('id', payload.userId)
        .single();

      if (!user) {
        return res.status(401).json({ error: 'User not found' });
      }

      // Generate new token pair
      const tokens = generateTokenPair({ userId: user.id, email: user.email });

      // Delete old refresh token and store new one
      await supabase
        .from('cb_refresh_tokens')
        .delete()
        .eq('id', matchedTokenId);

      const newRefreshTokenHash = await hashToken(tokens.refreshToken);
      const refreshExpiry = new Date();
      refreshExpiry.setDate(refreshExpiry.getDate() + 7);

      // Store new refresh token
      await supabase
        .from('cb_refresh_tokens')
        .insert({
          user_id: user.id,
          token_hash: newRefreshTokenHash,
          expires_at: refreshExpiry.toISOString()
        });

      console.log('[Auth] Tokens refreshed for:', user.email);

      res.json({
        user: {
          id: user.id,
          email: user.email,
          name: user.name
        },
        tokens
      });
    } catch (error: any) {
      console.error('[Auth] Refresh error:', error);
      res.status(500).json({ error: 'Token refresh failed' });
    }
  });
  

  // POST /auth/forgot-password
  router.post('/forgot-password', async (req: Request, res: Response) => {
    try {
      const { email } = req.body;

      if (!email) {
        return res.status(400).json({ error: 'Email is required' });
      }

      const normalizedEmail = email.toLowerCase().trim();

      // Find user (don't reveal if user exists or not)
      const { data: user } = await supabase
        .from('cb_users')
        .select('id, name')
        .eq('email', normalizedEmail)
        .single();

      // Always return success to prevent email enumeration
      const successMessage = 'If an account with that email exists, a password reset link has been sent.';

      if (!user) {
        console.log('[Auth] Password reset requested for non-existent email:', normalizedEmail);
        return res.json({ message: successMessage });
      }

      // Generate reset token
      const resetToken = generateRandomToken();
      const resetExpires = getPasswordResetExpiry();

      // Store reset token
      await supabase
        .from('cb_users')
        .update({
          password_reset_token: resetToken,
          password_reset_expires: resetExpires.toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('id', user.id);

      // Send reset email
      await sendPasswordResetEmail(normalizedEmail, resetToken, user.name);

      console.log('[Auth] Password reset email sent to:', normalizedEmail);

      res.json({ message: successMessage });
    } catch (error: any) {
      console.error('[Auth] Forgot password error:', error);
      res.status(500).json({ error: 'Failed to process request' });
    }
  });

  // POST /auth/reset-password
  router.post('/reset-password', async (req: Request, res: Response) => {
    try {
      const { token, password } = req.body;

      if (!token || !password) {
        return res.status(400).json({ error: 'Token and new password are required' });
      }

      if (password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
      }

      // Find user with this reset token
      const { data: user, error: findError } = await supabase
        .from('cb_users')
        .select('id, email, password_reset_expires')
        .eq('password_reset_token', token)
        .single();

      if (findError || !user) {
        return res.status(400).json({ error: 'Invalid or expired reset token' });
      }

      // Check if token has expired
      if (new Date(user.password_reset_expires) < new Date()) {
        return res.status(400).json({ error: 'Reset token has expired' });
      }

      // Hash new password
      const passwordHash = await hashPassword(password);

      // Update password and clear reset token
      const { error: updateError } = await supabase
        .from('cb_users')
        .update({
          password_hash: passwordHash,
          password_reset_token: null,
          password_reset_expires: null,
          updated_at: new Date().toISOString()
        })
        .eq('id', user.id);

      if (updateError) {
        console.error('[Auth] Password reset update error:', updateError);
        return res.status(500).json({ error: 'Failed to reset password' });
      }

      // Invalidate all refresh tokens for this user (force re-login)
      await supabase
        .from('cb_refresh_tokens')
        .delete()
        .eq('user_id', user.id);

      console.log('[Auth] Password reset for:', user.email);

      res.json({ message: 'Password reset successfully. You can now log in with your new password.' });
    } catch (error: any) {
      console.error('[Auth] Reset password error:', error);
      res.status(500).json({ error: 'Password reset failed' });
    }
  });

  // POST /auth/logout
  router.post('/logout', async (req: Request, res: Response) => {
    try {
      const { refreshToken } = req.body;

      if (refreshToken) {
        // Try to decode and delete the refresh token
        try {
          const payload = verifyRefreshToken(refreshToken);
          
          // Delete all refresh tokens for this user (or just the matching one)
          const { data: storedTokens } = await supabase
            .from('cb_refresh_tokens')
            .select('id, token_hash')
            .eq('user_id', payload.userId);

          if (storedTokens) {
            for (const stored of storedTokens) {
              const isMatch = await verifyTokenHash(refreshToken, stored.token_hash);
              if (isMatch) {
                await supabase
                  .from('cb_refresh_tokens')
                  .delete()
                  .eq('id', stored.id);
                break;
              }
            }
          }
        } catch (err) {
          // Token invalid, ignore
        }
      }

      res.json({ message: 'Logged out successfully' });
    } catch (error: any) {
      console.error('[Auth] Logout error:', error);
      res.status(500).json({ error: 'Logout failed' });
    }
  });

  // GET /auth/me - Get current user info (requires auth)
  router.get('/me', requireAuth, async (req: Request, res: Response) => {
    try {
      const { data: user, error } = await supabase
        .from('cb_users')
        .select('id, email, name, created_at')
        .eq('id', req.user!.userId)
        .single();

      if (error || !user) {
        return res.status(404).json({ error: 'User not found' });
      }

      res.json({ user });
    } catch (error: any) {
      console.error('[Auth] Get user error:', error);
      res.status(500).json({ error: 'Failed to get user info' });
    }
  });

  return router;
}