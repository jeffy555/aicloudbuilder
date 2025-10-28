import { Sparkles } from "lucide-react";

interface AIMessageProps {
  message: string;
}

export default function AIMessage({ message }: AIMessageProps) {
  return (
    <div className="flex gap-3 mb-4 max-w-2xl">
      <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center flex-shrink-0">
        <Sparkles className="w-4 h-4 text-primary-foreground" />
      </div>
      <div className="bg-card border border-card-border rounded-2xl p-4 flex-1">
        <p className="text-base text-card-foreground">{message}</p>
      </div>
    </div>
  );
}
