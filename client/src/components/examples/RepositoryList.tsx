import RepositoryList from '../RepositoryList';
import { useState } from 'react';

export default function RepositoryListExample() {
  const [selected, setSelected] = useState<string>('1');

  const mockRepos = [
    { id: '1', name: 'infrastructure-prod', branch: 'main', lastUpdated: '2 hours ago' },
    { id: '2', name: 'terraform-modules', branch: 'develop', lastUpdated: '1 day ago' },
    { id: '3', name: 'devops-automation', branch: 'main', lastUpdated: '3 days ago' },
    { id: '4', name: 'cloud-resources', branch: 'staging', lastUpdated: '1 week ago' },
  ];

  return (
    <div className="p-6 max-w-2xl">
      <RepositoryList 
        repositories={mockRepos} 
        selectedId={selected}
        onSelect={setSelected}
      />
    </div>
  );
}
