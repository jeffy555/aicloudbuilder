import type { User } from '@shared/schema';

export interface SignupRequest {
  username: string;
  email: string;
  password: string;
}

export interface LoginRequest {
  usernameOrEmail: string;
  password: string;
  rememberMe?: boolean;
}

/**
 * Store JWT in exactly one place. getCurrentUser reads localStorage before sessionStorage,
 * so we must clear the other store when logging in — otherwise a stale token wins.
 */
export function persistAuthToken(token: string, rememberMe: boolean): void {
  if (rememberMe) {
    sessionStorage.removeItem('token');
    localStorage.setItem('token', token);
  } else {
    localStorage.removeItem('token');
    sessionStorage.setItem('token', token);
  }
}

export interface AuthResponse {
  message: string;
  user: Omit<User, 'password'>;
  token: string;
}

export interface CurrentUserResponse {
  user: Omit<User, 'password'>;
}

/**
 * Sign up a new user
 */
export async function signup(data: SignupRequest): Promise<AuthResponse> {
  const response = await fetch('/api/auth/signup', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Signup failed');
  }

  return response.json();
}

/**
 * Log in a user
 */
export async function login(data: LoginRequest): Promise<AuthResponse> {
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    let msg = (error as { error?: string }).error || 'Login failed';
    const fieldErrors = (error as { errors?: { body?: Record<string, string[] | undefined> } }).errors?.body;
    if (fieldErrors && typeof fieldErrors === 'object') {
      const first = Object.values(fieldErrors).flat().find(Boolean);
      if (first) msg = String(first);
    }
    throw new Error(msg);
  }

  return response.json();
}

/**
 * Log out the current user
 */
export async function logout(): Promise<{ message: string }> {
  const token = localStorage.getItem('token') || sessionStorage.getItem('token');
  
  const response = await fetch('/api/auth/logout', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
    },
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Logout failed');
  }

  return response.json();
}

/**
 * Get the current authenticated user
 */
export async function getCurrentUser(): Promise<CurrentUserResponse> {
  const token = localStorage.getItem('token') || sessionStorage.getItem('token');

  if (!token) {
    throw new Error('No auth token');
  }

  const response = await fetch('/api/auth/me', {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    if (response.status === 401) {
      // Only clear token if server explicitly says the JWT is invalid/expired,
      // not on transient errors (e.g. server restart with MemStorage losing users).
      // The JWT itself may still be valid — the user record just needs to be re-created.
      const body = await response.json().catch(() => ({}));
      if (body?.error === 'Invalid or expired token' || body?.error === 'Token verification failed') {
        localStorage.removeItem('token');
        sessionStorage.removeItem('token');
      }
      throw new Error(body?.error || 'Authentication check failed');
    }
    const error = await response.json().catch(() => ({ error: 'Failed to get user' }));
    throw new Error(error.error || 'Failed to get user');
  }

  return response.json();
}

