import { Sparkles } from "lucide-react";

export default function Header() {
  return (
    <header className="h-16 border-b bg-background flex items-center justify-between px-6">
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 bg-primary rounded-lg flex items-center justify-center">
          <Sparkles className="w-5 h-5 text-primary-foreground" />
        </div>
        <h1 className="text-xl font-semibold">AI-Driven DevOps</h1>
      </div>
    </header>
  );
}
