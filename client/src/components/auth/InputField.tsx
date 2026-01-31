import { cn } from '@/lib/utils';

interface InputFieldProps {
  label: string;
  type: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  placeholder?: string;
  icon?: string;
  required?: boolean;
  autoComplete?: string;
}

export default function InputField({
  label,
  type,
  value,
  onChange,
  error,
  placeholder,
  icon,
  required,
  autoComplete,
}: InputFieldProps) {
  return (
    <div>
      <label className="block text-white/90 text-sm font-medium mb-2">
        {label}
        {required && <span className="text-red-400 ml-1">*</span>}
      </label>
      <div className="relative">
        {icon && (
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xl pointer-events-none">
            {icon}
          </span>
        )}
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete={autoComplete}
          className={cn(
            "w-full px-4 py-3 rounded-lg",
            "bg-white/10 backdrop-blur-sm",
            "border border-white/20",
            "text-white placeholder:text-white/50",
            "focus:outline-none focus:ring-2 focus:ring-cyan-400 focus:border-transparent",
            "transition-all",
            icon && "pl-10",
            error && "border-red-400 focus:ring-red-400"
          )}
          required={required}
          aria-invalid={error ? 'true' : 'false'}
          aria-describedby={error ? `${label}-error` : undefined}
        />
      </div>
      {error && (
        <p id={`${label}-error`} className="mt-1 text-sm text-red-400" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

