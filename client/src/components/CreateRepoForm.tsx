import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useState } from "react";
import { PlusIcon } from "@radix-ui/react-icons";

interface CreateRepoFormProps {
  onSubmit: (name: string, description: string) => void;
  loading?: boolean;
}

export default function CreateRepoForm({ onSubmit, loading = false }: CreateRepoFormProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (name.trim()) {
      onSubmit(name, description);
      setName("");
      setDescription("");
    }
  };

  return (
    <Card className="p-4">
      <h3 className="text-lg font-medium mb-4">Create New Repository</h3>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="repo-name">Repository Name</Label>
          <Input
            id="repo-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-terraform-repo"
            required
            data-testid="input-repo-name"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="repo-description">Description (Optional)</Label>
          <Textarea
            id="repo-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Terraform infrastructure configurations..."
            className="resize-none min-h-[80px]"
            data-testid="input-repo-description"
          />
        </div>
        <Button 
          type="submit" 
          className="w-full gap-2" 
          disabled={loading || !name.trim()}
          data-testid="button-create-repo"
        >
          <PlusIcon className="w-4 h-4" />
          Create Repository
        </Button>
      </form>
    </Card>
  );
}
