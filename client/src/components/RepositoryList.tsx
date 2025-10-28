import { Card } from "@/components/ui/card";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { FolderIcon } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";

interface Repository {
  id: string;
  name: string;
  lastUpdated?: string;
  branch?: string;
}

interface RepositoryListProps {
  repositories: Repository[];
  selectedId?: string;
  onSelect: (id: string) => void;
}

export default function RepositoryList({ repositories, selectedId, onSelect }: RepositoryListProps) {
  return (
    <Card className="p-4">
      <h3 className="text-lg font-medium mb-4">Select Repository</h3>
      <ScrollArea className="h-[400px]">
        <RadioGroup value={selectedId} onValueChange={onSelect}>
          <div className="space-y-2">
            {repositories.map((repo) => (
              <div
                key={repo.id}
                className="flex items-center gap-3 p-4 rounded-lg border hover-elevate cursor-pointer"
                onClick={() => onSelect(repo.id)}
                data-testid={`repo-item-${repo.id}`}
              >
                <RadioGroupItem value={repo.id} id={repo.id} data-testid={`radio-repo-${repo.id}`} />
                <FolderIcon className="w-5 h-5 text-muted-foreground flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <Label htmlFor={repo.id} className="font-medium cursor-pointer">
                    {repo.name}
                  </Label>
                  {(repo.lastUpdated || repo.branch) && (
                    <p className="text-xs text-muted-foreground mt-1">
                      {repo.branch && <span className="font-mono">{repo.branch}</span>}
                      {repo.branch && repo.lastUpdated && <span className="mx-2">•</span>}
                      {repo.lastUpdated}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </RadioGroup>
      </ScrollArea>
    </Card>
  );
}
