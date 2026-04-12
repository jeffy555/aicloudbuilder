import { useState } from 'react';
import { cn } from '@/lib/utils';

interface PasswordFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  placeholder?: string;
  showStrengthIndicator?: boolean;
  required?: boolean;
  autoComplete?: string;
  testId?: string;
}

export default function PasswordField({
  label,
  value,
  onChange,
  error,
  placeholder,
  showStrengthIndicator = false,
  required,
  autoComplete,
  testId,
}: PasswordFieldProps) {
  const [showPassword, setShowPassword] = useState(false);

  const getPasswordStrength = (password: string) => {
    if (password.length === 0) return { strength: 0, label: '', color: '' };
    if (password.length < 8) return { strength: 1, label: 'Weak', color: 'red' };
    
    const hasUpper = /[A-Z]/.test(password);
    const hasLower = /[a-z]/.test(password);
    const hasNumber = /[0-9]/.test(password);
    const hasSpecial = /[^A-Za-z0-9]/.test(password);
    
    const strength = [hasUpper, hasLower, hasNumber, hasSpecial].filter(Boolean).length;
    
    if (strength <= 2) return { strength, label: 'Weak', color: 'red' };
    if (strength === 3) return { strength, label: 'Medium', color: 'yellow' };
    return { strength, label: 'Strong', color: 'green' };
  };

  const strength = showStrengthIndicator ? getPasswordStrength(value) : null;

  return (
    <div>
      <label className="block text-white/90 text-sm font-medium mb-2">
        {label}
        {required && <span className="text-red-400 ml-1">*</span>}
      </label>
      <div className="relative">
        <input
          type={showPassword ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete={autoComplete}
          data-testid={testId}
          className={cn(
            "w-full px-4 py-3 rounded-lg",
            "bg-white/10 backdrop-blur-sm",
            "border border-white/20",
            "text-white placeholder:text-white/50",
            "focus:outline-none focus:ring-2 focus:ring-cyan-400 focus:border-transparent",
            "transition-all pr-10",
            error && "border-red-400 focus:ring-red-400"
          )}
          required={required}
          aria-invalid={error ? 'true' : 'false'}
          aria-describedby={error ? `${label}-error` : undefined}
        />
        <button
          type="button"
          onClick={() => setShowPassword(!showPassword)}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-white/70 hover:text-white transition-colors"
          aria-label={showPassword ? 'Hide password' : 'Show password'}
        >
          {showPassword ? '🙈' : '👁️'}
        </button>
      </div>
      
      {/* Password Strength Indicator */}
      {showStrengthIndicator && value && strength && (
        <div className="mt-2">
          <div className="flex items-center space-x-2">
            <div className="flex-1 h-2 bg-white/10 rounded-full overflow-hidden">
              <div
                className={cn(
                  "h-full transition-all",
                  strength.color === 'red' && "bg-red-400",
                  strength.color === 'yellow' && "bg-yellow-400",
                  strength.color === 'green' && "bg-green-400"
                )}
                style={{ width: `${(strength.strength / 4) * 100}%` }}
              />
            </div>
            <span className={cn(
              "text-xs",
              strength.color === 'red' && "text-red-400",
              strength.color === 'yellow' && "text-yellow-400",
              strength.color === 'green' && "text-green-400"
            )}>
              {strength.label}
            </span>
          </div>
        </div>
      )}
      
      {error && (
        <p id={`${label}-error`} className="mt-1 text-sm text-red-400" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

