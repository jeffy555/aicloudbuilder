import { useQuery } from "@tanstack/react-query";

export interface UserSecretsConfig {
  hasAzureDevOps: boolean;
  hasAzureCloud: boolean;
  hasGithub: boolean;
  hasAws: boolean;
  hasGcp: boolean;
  azureDevOps: {
    org: string;
    project: string;
    userId: string;
  } | null;
  azureCloud: {
    clientId: string;
    tenantId: string;
    subscriptionId: string;
  } | null;
  github: {
    owner: string;
  } | null;
  aws: {
    accessKeyId: string;
    region: string;
  } | null;
  gcp: {
    projectId: string;
    region: string;
  } | null;
}

export function useSecretsConfig() {
  return useQuery<UserSecretsConfig>({
    queryKey: ['user-secrets'],
    queryFn: async () => {
      const token = localStorage.getItem('token') || sessionStorage.getItem('token');
      const headers: Record<string, string> = {};
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const response = await fetch('/api/user/secrets', { headers });
      if (!response.ok) return { hasAzureDevOps: false, hasAzureCloud: false, hasGithub: false, hasAws: false, hasGcp: false, azureDevOps: null, azureCloud: null, github: null, aws: null, gcp: null };
      return response.json();
    },
  });
}

