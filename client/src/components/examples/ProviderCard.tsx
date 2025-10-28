import ProviderCard from '../ProviderCard';
import { CodeIcon } from "@radix-ui/react-icons";
import { Cloud } from "lucide-react";
import { useState } from 'react';

export default function ProviderCardExample() {
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-4 max-w-2xl">
      <ProviderCard
        icon={<CodeIcon className="w-6 h-6" />}
        title="GitHub"
        description="Use GitHub repositories for your Terraform configurations"
        onClick={() => setSelected('github')}
        selected={selected === 'github'}
      />
      <ProviderCard
        icon={<Cloud className="w-6 h-6" />}
        title="Azure DevOps"
        description="Use Azure DevOps repositories for your infrastructure code"
        onClick={() => setSelected('azure')}
        selected={selected === 'azure'}
      />
    </div>
  );
}
