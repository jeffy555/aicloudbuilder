export interface ValidationErrors {
  [key: string]: string;
}

export interface SignupFormData {
  username: string;
  email: string;
  password: string;
  confirmPassword: string;
}

export interface LoginFormData {
  usernameOrEmail: string;
  password: string;
  rememberMe: boolean;
}

/**
 * Validate username
 */
export function validateUsername(username: string): string | null {
  if (!username || username.trim().length === 0) {
    return 'Username is required';
  }
  
  if (username.length < 3) {
    return 'Username must be at least 3 characters';
  }
  
  if (username.length > 30) {
    return 'Username must be less than 30 characters';
  }
  
  if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
    return 'Username can only contain letters, numbers, underscores, and hyphens';
  }
  
  return null;
}

/**
 * Validate email
 */
export function validateEmail(email: string): string | null {
  if (!email || email.trim().length === 0) {
    return 'Email is required';
  }
  
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return 'Please enter a valid email address';
  }
  
  return null;
}

/**
 * Validate password
 */
export function validatePassword(password: string): string | null {
  if (!password || password.length === 0) {
    return 'Password is required';
  }
  
  if (password.length < 8) {
    return 'Password must be at least 8 characters long';
  }
  
  const hasUpperCase = /[A-Z]/.test(password);
  const hasLowerCase = /[a-z]/.test(password);
  const hasNumber = /[0-9]/.test(password);
  
  if (!hasUpperCase || !hasLowerCase || !hasNumber) {
    return 'Password must contain at least one uppercase letter, one lowercase letter, and one number';
  }
  
  return null;
}

/**
 * Validate confirm password
 */
export function validateConfirmPassword(password: string, confirmPassword: string): string | null {
  if (!confirmPassword || confirmPassword.length === 0) {
    return 'Please confirm your password';
  }
  
  if (password !== confirmPassword) {
    return 'Passwords do not match';
  }
  
  return null;
}

/**
 * Validate username or email (for login)
 */
export function validateUsernameOrEmail(usernameOrEmail: string): string | null {
  if (!usernameOrEmail || usernameOrEmail.trim().length === 0) {
    return 'Username or email is required';
  }
  
  return null;
}

/**
 * Validate signup form
 */
export function validateSignupForm(formData: SignupFormData): ValidationErrors {
  const errors: ValidationErrors = {};
  
  const usernameError = validateUsername(formData.username);
  if (usernameError) {
    errors.username = usernameError;
  }
  
  const emailError = validateEmail(formData.email);
  if (emailError) {
    errors.email = emailError;
  }
  
  const passwordError = validatePassword(formData.password);
  if (passwordError) {
    errors.password = passwordError;
  }
  
  const confirmPasswordError = validateConfirmPassword(formData.password, formData.confirmPassword);
  if (confirmPasswordError) {
    errors.confirmPassword = confirmPasswordError;
  }
  
  return errors;
}

/**
 * Validate login form
 */
export function validateLoginForm(formData: LoginFormData): ValidationErrors {
  const errors: ValidationErrors = {};
  
  const usernameOrEmailError = validateUsernameOrEmail(formData.usernameOrEmail);
  if (usernameOrEmailError) {
    errors.usernameOrEmail = usernameOrEmailError;
  }
  
  if (!formData.password || formData.password.length === 0) {
    errors.password = 'Password is required';
  }
  
  return errors;
}

/**
 * Hook for form validation
 */
export function useFormValidation() {
  return {
    validateUsername,
    validateEmail,
    validatePassword,
    validateConfirmPassword,
    validateUsernameOrEmail,
    validateSignupForm,
    validateLoginForm,
  };
}

