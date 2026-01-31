import { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface GlassCardProps {
  children: ReactNode;
  className?: string;
}

export default function GlassCard({ children, className }: GlassCardProps) {
  return (
    <div
      className={cn(
        "relative z-10",
        "bg-white/10 backdrop-blur-md",
        "border border-white/20",
        "rounded-2xl shadow-2xl",
        "p-8 md:p-10",
        "w-full max-w-md mx-auto",
        className
      )}
    >
      {children}
    </div>
  );
}

