import { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface SubmitButtonProps {
  children: ReactNode;
  type?: 'button' | 'submit' | 'reset';
  loading?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  testId?: string;
}

export default function SubmitButton({
  children,
  type = 'submit',
  loading = false,
  disabled = false,
  onClick,
  testId,
}: SubmitButtonProps) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || loading}
      data-testid={testId}
      className={cn(
        "w-full py-3 px-4 rounded-lg",
        "bg-gradient-to-r from-cyan-500 to-blue-600",
        "text-white font-semibold",
        "hover:from-cyan-400 hover:to-blue-500",
        "active:scale-95",
        "transition-all duration-200",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        "focus:outline-none focus:ring-2 focus:ring-cyan-400 focus:ring-offset-2 focus:ring-offset-transparent",
        "shadow-lg hover:shadow-xl"
      )}
    >
      {loading ? (
        <div className="flex items-center justify-center space-x-2">
          <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
          <span>Processing...</span>
        </div>
      ) : (
        children
      )}
    </button>
  );
}

