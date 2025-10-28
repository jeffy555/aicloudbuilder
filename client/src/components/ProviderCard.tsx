import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface ProviderCardProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  onClick: () => void;
  selected?: boolean;
}

export default function ProviderCard({ icon, title, description, onClick, selected = false }: ProviderCardProps) {
  return (
    <Card
      className={cn(
        "p-6 cursor-pointer transition-all hover-elevate active-elevate-2",
        selected && "ring-2 ring-primary"
      )}
      onClick={onClick}
      data-testid={`card-provider-${title.toLowerCase().replace(/\s+/g, '-')}`}
    >
      <div className="flex flex-col gap-4">
        <div className="w-12 h-12 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
          {icon}
        </div>
        <div>
          <h3 className="text-lg font-medium mb-1">{title}</h3>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
      </div>
    </Card>
  );
}
