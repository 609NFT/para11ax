/**
 * Admin authentication and session management utilities
 */

import crypto from 'crypto';
import { Request, Response } from 'express';

// ==================== SESSION CONFIGURATION ====================
export const ADMIN_SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// In-memory session store
const adminSessions = new Map<string, { expiresAt: number }>();

/**
 * Generate a cryptographically secure session ID
 */
export function generateSessionId(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Parse cookies from request header
 */
export function parseCookies(req: Request): Record<string, string> {
  const cookies: Record<string, string> = {};
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    cookieHeader.split(';').forEach(cookie => {
      const [name, ...rest] = cookie.trim().split('=');
      if (name && rest.length > 0) {
        cookies[name] = rest.join('=');
      }
    });
  }
  return cookies;
}

/**
 * Clean up expired sessions (called periodically)
 */
export function cleanupExpiredSessions(): void {
  const now = Date.now();
  for (const [sessionId, session] of adminSessions.entries()) {
    if (session.expiresAt < now) {
      adminSessions.delete(sessionId);
    }
  }
}

/**
 * Check if request has valid admin session cookie
 */
export function hasValidSession(req: Request): boolean {
  const cookies = parseCookies(req);
  const sessionId = cookies['admin_session'];
  if (!sessionId) return false;

  const session = adminSessions.get(sessionId);
  if (!session) return false;

  if (session.expiresAt < Date.now()) {
    adminSessions.delete(sessionId);
    return false;
  }

  return true;
}

/**
 * Check admin auth - returns true if authorized, sends error response if not
 */
export function checkAdminAuth(req: Request, res: Response): boolean {
  // First check for valid session cookie
  if (hasValidSession(req)) {
    return true;
  }

  // Fall back to token auth
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) {
    res.status(500).json({ error: 'ADMIN_TOKEN not configured on server' });
    return false;
  }
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token !== adminToken) {
    res.status(401).json({ error: 'Unauthorized - invalid admin token' });
    return false;
  }
  return true;
}

/**
 * Create a new session and return the session ID
 */
export function createSession(): string {
  const sessionId = generateSessionId();
  const expiresAt = Date.now() + ADMIN_SESSION_DURATION_MS;
  adminSessions.set(sessionId, { expiresAt });
  return sessionId;
}

/**
 * Delete a session by ID
 */
export function deleteSession(sessionId: string): void {
  adminSessions.delete(sessionId);
}

/**
 * Build the Set-Cookie header for a session
 */
export function buildSessionCookie(sessionId: string): string {
  const isProduction = process.env.NODE_ENV === 'production' || process.env.TUNNEL === 'true';
  const cookieOptions = [
    `admin_session=${sessionId}`,
    'HttpOnly',
    'Path=/',
    `Max-Age=${30 * 24 * 60 * 60}`, // 30 days in seconds
    'SameSite=Strict',
  ];
  if (isProduction) {
    cookieOptions.push('Secure');
  }
  return cookieOptions.join('; ');
}

/**
 * Build a cookie header that clears the session
 */
export function buildClearSessionCookie(): string {
  return 'admin_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict';
}

// Start cleanup interval (runs every hour)
setInterval(cleanupExpiredSessions, 60 * 60 * 1000);
