import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { useToast } from '@/hooks/use-toast';
import Header from '@/components/Header';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Settings as SettingsIcon, Cloud, CloudCog, Code, ShieldCheck, CheckCircle2, AlertCircle, Package } from 'lucide-react';

export default function Settings() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState('azure-devops');

  // Fetch existing secrets metadata
  const { data: config, isLoading } = useQuery({
    queryKey: ['user-secrets'],
    queryFn: async () => {
      const token = localStorage.getItem('token') || sessionStorage.getItem('token');
      const response = await fetch('/api/user/secrets', {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      if (!response.ok) throw new Error('Failed to fetch settings');
      return response.json();
    },
  });

  // State for forms
  const [azureDevOps, setAzureDevOps] = useState({
    org: '',
    project: '',
    pat: '',
    userId: '',
  });

  const [azureCloud, setAzureCloud] = useState({
    clientId: '',
    clientSecret: '',
    tenantId: '',
    subscriptionId: '',
  });

  const [aws, setAws] = useState({
    accessKeyId: '',
    secretAccessKey: '',
    region: 'us-east-1',
  });

  const [gcp, setGcp] = useState({
    projectId: '',
    clientEmail: '',
    privateKey: '',
    region: 'us-central1',
  });

  const [github, setGithub] = useState({
    token: '',
    owner: '',
  });

  const [isEditingDevOps, setIsEditingDevOps] = useState(false);
  const [isEditingCloud, setIsEditingCloud] = useState(false);
  const [isEditingGithub, setIsEditingGithub] = useState(false);
  const [isEditingAws, setIsEditingAws] = useState(false);
  const [isEditingGcp, setIsEditingGcp] = useState(false);

  // Load existing data into forms when query completes
  useEffect(() => {
    if (config) {
      if (config.azureDevOps) {
        setAzureDevOps(prev => ({
          ...prev,
          org: config.azureDevOps.org || '',
          project: config.azureDevOps.project || '',
          userId: config.azureDevOps.userId || '',
          pat: '', // Always keep PAT empty for security
        }));
        // If we have data and not currently editing, set to summary mode
        if (!isEditingDevOps && config.hasAzureDevOps) {
          setIsEditingDevOps(false);
        } else if (!config.hasAzureDevOps) {
          setIsEditingDevOps(true);
        }
      } else {
        setIsEditingDevOps(true);
      }

      if (config.azureCloud) {
        setAzureCloud(prev => ({
          ...prev,
          clientId: config.azureCloud.clientId || '',
          tenantId: config.azureCloud.tenantId || '',
          subscriptionId: config.azureCloud.subscriptionId || '',
          clientSecret: '', // Always keep Secret empty for security
        }));
        if (!isEditingCloud && config.hasAzureCloud) {
          setIsEditingCloud(false);
        } else if (!config.hasAzureCloud) {
          setIsEditingCloud(true);
        }
      } else {
        setIsEditingCloud(true);
      }

      if (config.aws) {
        setAws(prev => ({
          ...prev,
          accessKeyId: config.aws.accessKeyId || '',
          region: config.aws.region || 'us-east-1',
          secretAccessKey: '',
        }));
        if (!isEditingAws && config.hasAws) {
          setIsEditingAws(false);
        } else if (!config.hasAws) {
          setIsEditingAws(true);
        }
      } else {
        setIsEditingAws(true);
      }

      if (config.gcp) {
        setGcp(prev => ({
          ...prev,
          projectId: config.gcp.projectId || '',
          region: config.gcp.region || 'us-central1',
          clientEmail: config.gcp.clientEmail || '',
          privateKey: '',
        }));
        if (!isEditingGcp && config.hasGcp) {
          setIsEditingGcp(false);
        } else if (!config.hasGcp) {
          setIsEditingGcp(true);
        }
      } else {
        setIsEditingGcp(true);
      }

      if (config.github) {
        setGithub(prev => ({
          ...prev,
          owner: config.github.owner || '',
          token: '', // Always keep token empty for security
        }));
        if (!isEditingGithub && config.hasGithub) {
          setIsEditingGithub(false);
        } else if (!config.hasGithub) {
          setIsEditingGithub(true);
        }
      } else {
        setIsEditingGithub(true);
      }
    }
  }, [config]);

  // Mutation to save secrets
  const saveMutation = useMutation({
    mutationFn: async ({ type, data }: { type: string, data: any }) => {
      const token = localStorage.getItem('token') || sessionStorage.getItem('token');
      const response = await fetch(`/api/user/secrets/${type}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(data),
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Failed to save');
      }
      return response.json();
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['user-secrets'] });
      if (variables.type === 'azure-devops') setIsEditingDevOps(false);
      if (variables.type === 'azure-cloud') setIsEditingCloud(false);
      if (variables.type === 'github') setIsEditingGithub(false);
      if (variables.type === 'aws') setIsEditingAws(false);
      if (variables.type === 'gcp') setIsEditingGcp(false);
      
      const typeName = variables.type === 'azure-devops' ? 'Azure DevOps' : 
                      variables.type === 'azure-cloud' ? 'Azure Cloud' :
                      variables.type === 'aws' ? 'AWS' :
                      variables.type === 'gcp' ? 'GCP' : 'GitHub';

      toast({
        title: "Settings Saved",
        description: `${typeName} configuration has been pushed to Bitwarden Vault.`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleSaveAzureDevOps = (e: React.FormEvent) => {
    e.preventDefault();
    saveMutation.mutate({ type: 'azure-devops', data: azureDevOps });
  };

  const handleSaveAzureCloud = (e: React.FormEvent) => {
    e.preventDefault();
    saveMutation.mutate({ type: 'azure-cloud', data: azureCloud });
  };

  const handleSaveAws = (e: React.FormEvent) => {
    e.preventDefault();
    saveMutation.mutate({ type: 'aws', data: aws });
  };

  const handleSaveGcp = (e: React.FormEvent) => {
    e.preventDefault();
    saveMutation.mutate({ type: 'gcp', data: gcp });
  };

  const handleSaveGithub = (e: React.FormEvent) => {
    e.preventDefault();
    saveMutation.mutate({ type: 'github', data: github });
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background">
        <Header />
        <div className="container mx-auto px-6 py-12 flex justify-center">
          <div className="flex flex-col items-center gap-4">
            <div className="w-12 h-12 border-4 border-primary/20 border-t-primary rounded-full animate-spin" />
            <p className="text-muted-foreground">Loading configurations...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background pb-20">
      <Header />
      
      <main className="container mx-auto px-6 py-12 max-w-4xl">
        <div className="flex items-center gap-3 mb-8">
          <div className="p-3 rounded-xl bg-primary/10 text-primary">
            <SettingsIcon className="w-8 h-8" />
          </div>
          <div>
            <h1 className="text-3xl font-bold tracking-tight">System Configuration</h1>
            <p className="text-muted-foreground">Manage your repository and cloud credentials securely in Bitwarden</p>
          </div>
        </div>

        <div className="w-full">
          <div className="flex mb-8 bg-muted/50 p-1 rounded-xl w-fit flex-wrap gap-1">
            <Button
              variant={activeTab === 'azure-devops' ? 'secondary' : 'ghost'}
              className="gap-2 rounded-lg"
              onClick={() => setActiveTab('azure-devops')}
            >
              <Code className="w-4 h-4" />
              Azure DevOps
              {config?.hasAzureDevOps && <CheckCircle2 className="w-3 h-3 text-green-500" />}
            </Button>
            <Button
              variant={activeTab === 'github' ? 'secondary' : 'ghost'}
              className="gap-2 rounded-lg"
              onClick={() => setActiveTab('github')}
            >
              <Code className="w-4 h-4" />
              GitHub
              {config?.hasGithub && <CheckCircle2 className="w-3 h-3 text-green-500" />}
            </Button>
            <Button
              variant={activeTab === 'azure-cloud' ? 'secondary' : 'ghost'}
              className="gap-2 rounded-lg"
              onClick={() => setActiveTab('azure-cloud')}
            >
              <Cloud className="w-4 h-4" />
              Azure
              {config?.hasAzureCloud && <CheckCircle2 className="w-3 h-3 text-green-500" />}
            </Button>
            <Button
              variant={activeTab === 'aws' ? 'secondary' : 'ghost'}
              className="gap-2 rounded-lg"
              onClick={() => setActiveTab('aws')}
            >
              <CloudCog className="w-4 h-4" />
              AWS
              {config?.hasAws && <CheckCircle2 className="w-3 h-3 text-green-500" />}
            </Button>
            <Button
              variant={activeTab === 'gcp' ? 'secondary' : 'ghost'}
              className="gap-2 rounded-lg"
              onClick={() => setActiveTab('gcp')}
            >
              <Package className="w-4 h-4" />
              GCP
              {config?.hasGcp && <CheckCircle2 className="w-3 h-3 text-green-500" />}
            </Button>
          </div>

        {activeTab === 'azure-devops' && (
          <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3 }}
            >
              <Card className="border-border/50 shadow-xl overflow-hidden">
                <CardHeader className="bg-primary/5 border-b border-border/50 py-6">
                  <div className="flex justify-between items-start">
                    <div>
                      <CardTitle className="text-xl">Azure DevOps Settings</CardTitle>
                      <CardDescription>Target repository details for automation</CardDescription>
                    </div>
                    <div className="px-3 py-1 rounded-full bg-blue-500/10 text-blue-500 text-xs font-semibold flex items-center gap-1.5 border border-blue-500/20">
                      <ShieldCheck className="w-3 h-3" />
                      Stored in Bitwarden
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="p-8">
                  {config?.hasAzureDevOps && !isEditingDevOps ? (
                    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-8 bg-muted/20 p-8 rounded-2xl border border-border/50 shadow-inner">
                        <div className="space-y-1">
                          <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">Organization</p>
                          <p className="text-lg font-semibold text-primary">{config.azureDevOps.org}</p>
                        </div>
                        <div className="space-y-1">
                          <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">Project</p>
                          <p className="text-lg font-semibold text-primary">{config.azureDevOps.project}</p>
                        </div>
                        <div className="space-y-1">
                          <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">User ID</p>
                          <p className="text-lg font-semibold text-primary">{config.azureDevOps.userId}</p>
                        </div>
                        <div className="space-y-1">
                          <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">Vault Status</p>
                          <div className="flex items-center gap-2 text-green-500 font-bold">
                            <ShieldCheck className="w-5 h-5" />
                            <span className="text-sm">Securely Locked</span>
                          </div>
                        </div>
                      </div>
                      
                      <div className="flex flex-col items-center gap-4 py-4">
                        <div className="flex items-center gap-2 text-muted-foreground text-sm">
                          <CheckCircle2 className="w-4 h-4 text-green-500" />
                          Configuration is synced with Bitwarden Secrets Manager
                        </div>
                        <Button 
                          variant="secondary" 
                          onClick={() => setIsEditingDevOps(true)}
                          className="gap-2 px-8 py-6 rounded-xl hover:bg-primary hover:text-white transition-all duration-300"
                        >
                          <SettingsIcon className="w-4 h-4" />
                          Modify Azure DevOps Settings
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <form onSubmit={handleSaveAzureDevOps} className="space-y-6">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div className="space-y-2">
                          <Label htmlFor="org">Organization Name</Label>
                          <Input 
                            id="org" 
                            placeholder="e.g. MyOrg" 
                            value={azureDevOps.org} 
                            onChange={(e) => setAzureDevOps(prev => ({ ...prev, org: e.target.value }))}
                            required
                            autoComplete="off"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="project">Project Name</Label>
                          <Input 
                            id="project" 
                            placeholder="e.g. CloudInfrastructure" 
                            value={azureDevOps.project} 
                            onChange={(e) => setAzureDevOps(prev => ({ ...prev, project: e.target.value }))}
                            required
                            autoComplete="off"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="userId">Azure DevOps User ID</Label>
                          <Input 
                            id="userId" 
                            placeholder="e.g. user@example.com" 
                            value={azureDevOps.userId} 
                            onChange={(e) => setAzureDevOps(prev => ({ ...prev, userId: e.target.value }))}
                            required
                            autoComplete="off"
                          />
                        </div>
                        <div className="space-y-2 md:col-span-2">
                          <Label htmlFor="pat">Personal Access Token (PAT)</Label>
                          <div className="relative">
                            <Input 
                              id="pat" 
                              type="password" 
                              placeholder="Full scope or Read/Write Repo PAT" 
                              value={azureDevOps.pat} 
                              onChange={(e) => setAzureDevOps(prev => ({ ...prev, pat: e.target.value }))}
                              required
                              autoComplete="new-password"
                            />
                          </div>
                          <p className="text-[10px] text-muted-foreground flex items-center gap-1 mt-1">
                            <AlertCircle className="w-3 h-3" />
                            Requires Repo (Read & Write) and Build (Read & Execute) scopes
                          </p>
                        </div>
                      </div>
                      
                      <div className="pt-4 border-t border-border/50 flex justify-end gap-3">
                        {config?.hasAzureDevOps && (
                          <Button type="button" variant="ghost" onClick={() => setIsEditingDevOps(false)}>
                            Cancel
                          </Button>
                        )}
                        <Button type="submit" disabled={saveMutation.isPending} className="px-8 shadow-lg shadow-primary/20">
                          {saveMutation.isPending ? 'Saving to Vault...' : 'Save Configuration'}
                        </Button>
                      </div>
                    </form>
                  )}
                </CardContent>
              </Card>
            </motion.div>
        )}

        {activeTab === 'github' && (
          <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3 }}
            >
              <Card className="border-border/50 shadow-xl overflow-hidden">
                <CardHeader className="bg-primary/5 border-b border-border/50 py-6">
                  <div className="flex justify-between items-start">
                    <div>
                      <CardTitle className="text-xl">GitHub Settings</CardTitle>
                      <CardDescription>Target repository details for automation</CardDescription>
                    </div>
                    <div className="px-3 py-1 rounded-full bg-blue-500/10 text-blue-500 text-xs font-semibold flex items-center gap-1.5 border border-blue-500/20">
                      <ShieldCheck className="w-3 h-3" />
                      Stored in Bitwarden
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="p-8">
                  {config?.hasGithub && !isEditingGithub ? (
                    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-8 bg-muted/20 p-8 rounded-2xl border border-border/50 shadow-inner">
                        <div className="space-y-1">
                          <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">Owner (User/Org)</p>
                          <p className="text-lg font-semibold text-primary">{config.github.owner}</p>
                        </div>
                        <div className="space-y-1">
                          <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">Vault Status</p>
                          <div className="flex items-center gap-2 text-green-500 font-bold">
                            <ShieldCheck className="w-5 h-5" />
                            <span className="text-sm">Securely Locked</span>
                          </div>
                        </div>
                      </div>
                      
                      <div className="flex flex-col items-center gap-4 py-4">
                        <div className="flex items-center gap-2 text-muted-foreground text-sm">
                          <CheckCircle2 className="w-4 h-4 text-green-500" />
                          Configuration is synced with Bitwarden Secrets Manager
                        </div>
                        <Button 
                          variant="secondary" 
                          onClick={() => setIsEditingGithub(true)}
                          className="gap-2 px-8 py-6 rounded-xl hover:bg-primary hover:text-white transition-all duration-300"
                        >
                          <SettingsIcon className="w-4 h-4" />
                          Modify GitHub Settings
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <form onSubmit={handleSaveGithub} className="space-y-6">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div className="space-y-2">
                          <Label htmlFor="githubOwner">Owner (Username or Organization)</Label>
                          <Input 
                            id="githubOwner" 
                            placeholder="e.g. MyGithubUser" 
                            value={github.owner} 
                            onChange={(e) => setGithub(prev => ({ ...prev, owner: e.target.value }))}
                            required
                            autoComplete="off"
                          />
                        </div>
                        <div className="space-y-2 md:col-span-2">
                          <Label htmlFor="githubToken">GitHub Personal Access Token</Label>
                          <Input 
                            id="githubToken" 
                            type="password" 
                            placeholder="ghp_xxxxxxxxxxxx" 
                            value={github.token} 
                            onChange={(e) => setGithub(prev => ({ ...prev, token: e.target.value }))}
                            required
                            autoComplete="new-password"
                          />
                          <p className="text-[10px] text-muted-foreground flex items-center gap-1 mt-1">
                            <AlertCircle className="w-3 h-3" />
                            Requires 'repo' scope for repository management
                          </p>
                        </div>
                      </div>
                      
                      <div className="pt-4 border-t border-border/50 flex justify-end gap-3">
                        {config?.hasGithub && (
                          <Button type="button" variant="ghost" onClick={() => setIsEditingGithub(false)}>
                            Cancel
                          </Button>
                        )}
                        <Button type="submit" disabled={saveMutation.isPending} className="px-8 shadow-lg shadow-primary/20">
                          {saveMutation.isPending ? 'Saving to Vault...' : 'Save Configuration'}
                        </Button>
                      </div>
                    </form>
                  )}
                </CardContent>
              </Card>
            </motion.div>
        )}

        {activeTab === 'azure-cloud' && (
          <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3 }}
            >
              <Card className="border-border/50 shadow-xl overflow-hidden">
                <CardHeader className="bg-primary/5 border-b border-border/50 py-6">
                  <div className="flex justify-between items-start">
                    <div>
                      <CardTitle className="text-xl">Azure Credentials</CardTitle>
                      <CardDescription>Authentication for resource deployment</CardDescription>
                    </div>
                    <div className="px-3 py-1 rounded-full bg-blue-500/10 text-blue-500 text-xs font-semibold flex items-center gap-1.5 border border-blue-500/20">
                      <ShieldCheck className="w-3 h-3" />
                      Stored in Bitwarden
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="p-8">
                  {config?.hasAzureCloud && !isEditingCloud ? (
                    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-8 bg-muted/20 p-8 rounded-2xl border border-border/50 shadow-inner">
                        <div className="space-y-1">
                          <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">Tenant ID</p>
                          <p className="text-lg font-semibold text-primary">{config.azureCloud.tenantId}</p>
                        </div>
                        <div className="space-y-1">
                          <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">Subscription ID</p>
                          <p className="text-lg font-semibold text-primary">{config.azureCloud.subscriptionId}</p>
                        </div>
                        <div className="space-y-1">
                          <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">Client ID</p>
                          <p className="text-lg font-semibold text-primary">{config.azureCloud.clientId}</p>
                        </div>
                        <div className="space-y-1">
                          <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">Secret Status</p>
                          <div className="flex items-center gap-2 text-green-500 font-bold">
                            <ShieldCheck className="w-5 h-5" />
                            <span className="text-sm">Securely Active</span>
                          </div>
                        </div>
                      </div>
                      
                      <div className="flex flex-col items-center gap-4 py-4">
                        <div className="flex items-center gap-2 text-muted-foreground text-sm">
                          <CheckCircle2 className="w-4 h-4 text-green-500" />
                          Authentication credentials are saved in Bitwarden
                        </div>
                        <Button 
                          variant="secondary" 
                          onClick={() => setIsEditingCloud(true)}
                          className="gap-2 px-8 py-6 rounded-xl hover:bg-primary hover:text-white transition-all duration-300"
                        >
                          <SettingsIcon className="w-4 h-4" />
                          Modify Azure Settings
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <form onSubmit={handleSaveAzureCloud} className="space-y-6">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div className="space-y-2">
                          <Label htmlFor="tenantId">Tenant ID</Label>
                          <Input 
                            id="tenantId" 
                            placeholder="Directory (tenant) ID" 
                            value={azureCloud.tenantId} 
                            onChange={(e) => setAzureCloud(prev => ({ ...prev, tenantId: e.target.value }))}
                            required
                            autoComplete="off"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="subscriptionId">Subscription ID</Label>
                          <Input 
                            id="subscriptionId" 
                            placeholder="Azure Subscription ID" 
                            value={azureCloud.subscriptionId} 
                            onChange={(e) => setAzureCloud(prev => ({ ...prev, subscriptionId: e.target.value }))}
                            required
                            autoComplete="off"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="clientId">Client ID (Application ID)</Label>
                          <Input 
                            id="clientId" 
                            placeholder="Service Principal Client ID" 
                            value={azureCloud.clientId} 
                            onChange={(e) => setAzureCloud(prev => ({ ...prev, clientId: e.target.value }))}
                            required
                            autoComplete="off"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="clientSecret">Client Secret</Label>
                          <Input 
                            id="clientSecret" 
                            type="password" 
                            placeholder="Service Principal Secret Key" 
                            value={azureCloud.clientSecret} 
                            onChange={(e) => setAzureCloud(prev => ({ ...prev, clientSecret: e.target.value }))}
                            required
                            autoComplete="new-password"
                          />
                        </div>
                      </div>
                      
                      <div className="pt-4 border-t border-border/50 flex justify-end gap-3">
                        {config?.hasAzureCloud && (
                          <Button type="button" variant="ghost" onClick={() => setIsEditingCloud(false)}>
                            Cancel
                          </Button>
                        )}
                        <Button type="submit" disabled={saveMutation.isPending} className="px-8 shadow-lg shadow-primary/20">
                          {saveMutation.isPending ? 'Saving to Vault...' : 'Save Configuration'}
                        </Button>
                      </div>
                    </form>
                  )}
                </CardContent>
              </Card>
            </motion.div>
        )}

        {activeTab === 'aws' && (
          <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3 }}
            >
              <Card className="border-border/50 shadow-xl overflow-hidden">
                <CardHeader className="bg-primary/5 border-b border-border/50 py-6">
                  <div className="flex justify-between items-start">
                    <div>
                      <CardTitle className="text-xl">AWS Credentials</CardTitle>
                      <CardDescription>Authentication for resource deployment</CardDescription>
                    </div>
                    <div className="px-3 py-1 rounded-full bg-blue-500/10 text-blue-500 text-xs font-semibold flex items-center gap-1.5 border border-blue-500/20">
                      <ShieldCheck className="w-3 h-3" />
                      Stored in Bitwarden
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="p-8">
                  {config?.hasAws && !isEditingAws ? (
                    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-8 bg-muted/20 p-8 rounded-2xl border border-border/50 shadow-inner">
                        <div className="space-y-1">
                          <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">Access Key ID</p>
                          <p className="text-lg font-semibold text-primary">{config.aws.accessKeyId}</p>
                        </div>
                        <div className="space-y-1">
                          <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">Default Region</p>
                          <p className="text-lg font-semibold text-primary">{config.aws.region}</p>
                        </div>
                        <div className="space-y-1">
                          <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">Secret Status</p>
                          <div className="flex items-center gap-2 text-green-500 font-bold">
                            <ShieldCheck className="w-5 h-5" />
                            <span className="text-sm">Securely Active</span>
                          </div>
                        </div>
                      </div>
                      
                      <div className="flex flex-col items-center gap-4 py-4">
                        <div className="flex items-center gap-2 text-muted-foreground text-sm">
                          <CheckCircle2 className="w-4 h-4 text-green-500" />
                          Authentication credentials are saved in Bitwarden
                        </div>
                        <Button 
                          variant="secondary" 
                          onClick={() => setIsEditingAws(true)}
                          className="gap-2 px-8 py-6 rounded-xl hover:bg-primary hover:text-white transition-all duration-300"
                        >
                          <SettingsIcon className="w-4 h-4" />
                          Modify AWS Settings
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <form onSubmit={handleSaveAws} className="space-y-6">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div className="space-y-2">
                          <Label htmlFor="accessKeyId">Access Key ID</Label>
                          <Input 
                            id="accessKeyId" 
                            placeholder="AKIA..." 
                            value={aws.accessKeyId} 
                            onChange={(e) => setAws(prev => ({ ...prev, accessKeyId: e.target.value }))}
                            required
                            autoComplete="off"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="secretAccessKey">Secret Access Key</Label>
                          <Input 
                            id="secretAccessKey" 
                            type="password" 
                            placeholder="AWS Secret Access Key" 
                            value={aws.secretAccessKey} 
                            onChange={(e) => setAws(prev => ({ ...prev, secretAccessKey: e.target.value }))}
                            required
                            autoComplete="new-password"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="awsRegion">Default Region</Label>
                          <Input 
                            id="awsRegion" 
                            placeholder="e.g. us-east-1" 
                            value={aws.region} 
                            onChange={(e) => setAws(prev => ({ ...prev, region: e.target.value }))}
                            required
                            autoComplete="off"
                          />
                        </div>
                      </div>
                      
                      <div className="pt-4 border-t border-border/50 flex justify-end gap-3">
                        {config?.hasAws && (
                          <Button type="button" variant="ghost" onClick={() => setIsEditingAws(false)}>
                            Cancel
                          </Button>
                        )}
                        <Button type="submit" disabled={saveMutation.isPending} className="px-8 shadow-lg shadow-primary/20">
                          {saveMutation.isPending ? 'Saving to Vault...' : 'Save Configuration'}
                        </Button>
                      </div>
                    </form>
                  )}
                </CardContent>
              </Card>
            </motion.div>
        )}

        {activeTab === 'gcp' && (
          <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3 }}
            >
              <Card className="border-border/50 shadow-xl overflow-hidden">
                <CardHeader className="bg-primary/5 border-b border-border/50 py-6">
                  <div className="flex justify-between items-start">
                    <div>
                      <CardTitle className="text-xl">GCP Credentials</CardTitle>
                      <CardDescription>Authentication for resource deployment</CardDescription>
                    </div>
                    <div className="px-3 py-1 rounded-full bg-blue-500/10 text-blue-500 text-xs font-semibold flex items-center gap-1.5 border border-blue-500/20">
                      <ShieldCheck className="w-3 h-3" />
                      Stored in Bitwarden
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="p-8">
                  {config?.hasGcp && !isEditingGcp ? (
                    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-8 bg-muted/20 p-8 rounded-2xl border border-border/50 shadow-inner">
                        <div className="space-y-1">
                          <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">Project ID</p>
                          <p className="text-lg font-semibold text-primary">{config.gcp.projectId}</p>
                        </div>
                        <div className="space-y-1">
                          <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">Client Email</p>
                          <p className="text-lg font-semibold text-primary">{config.gcp.clientEmail}</p>
                        </div>
                        <div className="space-y-1">
                          <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">Default Region</p>
                          <p className="text-lg font-semibold text-primary">{config.gcp.region}</p>
                        </div>
                        <div className="space-y-1">
                          <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">Key Status</p>
                          <div className="flex items-center gap-2 text-green-500 font-bold">
                            <ShieldCheck className="w-5 h-5" />
                            <span className="text-sm">Securely Active</span>
                          </div>
                        </div>
                      </div>
                      
                      <div className="flex flex-col items-center gap-4 py-4">
                        <div className="flex items-center gap-2 text-muted-foreground text-sm">
                          <CheckCircle2 className="w-4 h-4 text-green-500" />
                          Authentication credentials are saved in Bitwarden
                        </div>
                        <Button 
                          variant="secondary" 
                          onClick={() => setIsEditingGcp(true)}
                          className="gap-2 px-8 py-6 rounded-xl hover:bg-primary hover:text-white transition-all duration-300"
                        >
                          <SettingsIcon className="w-4 h-4" />
                          Modify GCP Settings
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <form onSubmit={handleSaveGcp} className="space-y-6">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div className="space-y-2">
                          <Label htmlFor="gcpProjectId">Project ID</Label>
                          <Input 
                            id="gcpProjectId" 
                            placeholder="my-gcp-project" 
                            value={gcp.projectId} 
                            onChange={(e) => setGcp(prev => ({ ...prev, projectId: e.target.value }))}
                            required
                            autoComplete="off"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="clientEmail">Client Email</Label>
                          <Input 
                            id="clientEmail" 
                            placeholder="service-account@project.iam.gserviceaccount.com" 
                            value={gcp.clientEmail} 
                            onChange={(e) => setGcp(prev => ({ ...prev, clientEmail: e.target.value }))}
                            required
                            autoComplete="off"
                          />
                        </div>
                        <div className="space-y-2 md:col-span-2">
                          <Label htmlFor="privateKey">Private Key</Label>
                          <textarea 
                            id="privateKey" 
                            className="flex min-h-[120px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                            placeholder="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----" 
                            value={gcp.privateKey} 
                            onChange={(e) => setGcp(prev => ({ ...prev, privateKey: e.target.value }))}
                            required
                            autoComplete="new-password"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="gcpRegion">Default Region</Label>
                          <Input 
                            id="gcpRegion" 
                            placeholder="e.g. us-central1" 
                            value={gcp.region} 
                            onChange={(e) => setGcp(prev => ({ ...prev, region: e.target.value }))}
                            required
                            autoComplete="off"
                          />
                        </div>
                      </div>
                      
                      <div className="pt-4 border-t border-border/50 flex justify-end gap-3">
                        {config?.hasGcp && (
                          <Button type="button" variant="ghost" onClick={() => setIsEditingGcp(false)}>
                            Cancel
                          </Button>
                        )}
                        <Button type="submit" disabled={saveMutation.isPending} className="px-8 shadow-lg shadow-primary/20">
                          {saveMutation.isPending ? 'Saving to Vault...' : 'Save Configuration'}
                        </Button>
                      </div>
                    </form>
                  )}
                </CardContent>
              </Card>
            </motion.div>
        )}
        </div>
      </main>
    </div>
  );
}

