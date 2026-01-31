import { useState, useMemo } from "react";
import { Card } from "@/components/ui/card";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { FolderIcon, Search } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";

export interface Repository {
  id: string;
  name: string;
  fullName?: string;
  lastUpdated?: string;
  branch?: string;
}

interface RepositoryListProps {
  repositories: Repository[];
  selectedId?: string;
  onSelect: (id: string) => void;
  onRepoSelect?: (repo: Repository) => void;
  showSearch?: boolean;
  hideCard?: boolean;
  className?: string;
}

export default function RepositoryList({
  repositories,
  selectedId,
  onSelect,
  onRepoSelect,
  showSearch = false,
  hideCard = false,
  className,
}: RepositoryListProps) {
  const [searchQuery, setSearchQuery] = useState("");

  // Filter repositories based on search query
  const filteredRepositories = useMemo(() => {
    if (!searchQuery.trim()) {
      return repositories;
    }
    
    const query = searchQuery.toLowerCase();
    return repositories.filter(repo => 
      repo.name.toLowerCase().includes(query) ||
      repo.id.toLowerCase().includes(query) ||
      (repo.branch && repo.branch.toLowerCase().includes(query))
    );
  }, [repositories, searchQuery]);

  const handleValueChange = (value: string) => {
    onSelect(value);
    const repo = repositories.find((repo) => repo.id === value);
    if (repo) {
      onRepoSelect?.(repo);
    }
  };

  const innerContent = (
    <div className="space-y-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-medium">Select Repository</h3>
        {filteredRepositories.length !== repositories.length && (
          <span className="text-xs text-muted-foreground">
            {filteredRepositories.length} of {repositories.length}
          </span>
        )}
      </div>

      {showSearch && (
        <div className="mb-4 relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            type="text"
            placeholder="Search repositories..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>
      )}

      <ScrollArea className="h-[400px]">
        {filteredRepositories.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <p>No repositories found</p>
            {searchQuery && (
              <p className="text-xs mt-2">Try a different search term</p>
            )}
          </div>
        ) : (
          <RadioGroup value={selectedId} onValueChange={handleValueChange}>
            <div className="space-y-2">
              {filteredRepositories.map((repo) => (
                <div
                  key={repo.id}
                  className="flex items-center gap-3 p-4 rounded-lg border hover-elevate cursor-pointer"
                  onClick={() => handleValueChange(repo.id)}
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
        )}
      </ScrollArea>
    </div>
  );

  const paddedContent = <div className="p-4">{innerContent}</div>;

  if (hideCard) {
    return <div className={className}>{paddedContent}</div>;
  }

  return (
    <Card className={className ?? ""}>
      {paddedContent}
    </Card>
  );
}
