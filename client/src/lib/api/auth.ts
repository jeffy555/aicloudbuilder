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
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Login failed');
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
  
  const response = await fetch('/api/auth/me', {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
    },
  });

  if (!response.ok) {
    if (response.status === 401) {
      // Clear invalid token
      localStorage.removeItem('token');
      sessionStorage.removeItem('token');
    }
    const error = await response.json();
    throw new Error(error.error || 'Failed to get user');
  }

  return response.json();
}

