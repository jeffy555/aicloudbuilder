import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { useSecretsConfig } from "@/hooks/useSecretsConfig";
import { FileCode, Settings as SettingsIcon, Terminal, Network, Package, AlertTriangle, ArrowRight, FileChartPie } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import Header from "@/components/Header";

interface FeatureCardProps {
  to: string;
  icon: React.ReactNode;
  title: string;
  description: string;
  available: boolean;
  disabled?: boolean;
}

function FeatureCard({ to, icon, title, description, available, disabled }: FeatureCardProps) {
  const content = (
    <Card 
      className={`transition-all min-h-[170px] h-full flex flex-col justify-between ${available && !disabled ? 'hover-elevate active-elevate-2 cursor-pointer' : 'opacity-60 cursor-not-allowed'}`}
      data-testid={`card-feature-${title.toLowerCase()}`}
    >
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="p-3 rounded-lg bg-primary/10 text-primary">
            {icon}
          </div>
          <div>
            <CardTitle>{title}</CardTitle>
            {!available && (
              <span className="text-xs text-muted-foreground">Coming Soon</span>
            )}
            {available && disabled && (
              <span className="text-xs text-amber-500 font-medium">Setup Required</span>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <CardDescription className="text-sm">
          {description}
        </CardDescription>
      </CardContent>
    </Card>
  );

  if (available && !disabled) {
    return <Link href={to}>{content}</Link>;
  }

  return <div>{content}</div>;
}

export default function Landing() {
  const [, setLocation] = useLocation();

  // Fetch secrets configuration status
  const { data: config, isLoading } = useSecretsConfig();

  const isConfigured = (config?.hasAzureDevOps || config?.hasGithub) && (config?.hasAzureCloud || config?.hasAws || config?.hasGcp);

  const missingRepos = !config?.hasAzureDevOps && !config?.hasGithub;
  const missingCloud = !config?.hasAzureCloud && !config?.hasAws && !config?.hasGcp;

  return (
    <div className="min-h-screen bg-background">
      <Header />

      <main className="container mx-auto px-6 py-12">
        <div className="max-w-5xl mx-auto">
          {!isLoading && !isConfigured && (
            <motion.div
              initial={{ opacity: 0, y: -20 }}
              animate={{ opacity: 1, y: 0 }}
              className="mb-8"
            >
              <Alert variant="default" className="border-amber-500/50 bg-amber-500/5 shadow-lg overflow-hidden relative">
                <div className="absolute top-0 left-0 w-1 h-full bg-amber-500" />
                <AlertTriangle className="h-5 w-5 text-amber-500" />
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 w-full">
                  <div>
                    <AlertTitle className="text-amber-500 font-bold">System Setup Required</AlertTitle>
                    <AlertDescription className="text-muted-foreground max-w-2xl">
                      {missingRepos && missingCloud 
                        ? "To start using automation workflows, you need to configure at least one Repository provider (GitHub/Azure DevOps) and one Cloud provider (Azure/AWS/GCP)."
                        : missingRepos 
                          ? "You have configured a Cloud provider, but you still need to setup a Repository provider (GitHub or Azure DevOps) to store your code."
                          : "You have configured your repository, but you still need to setup Cloud credentials (Azure, AWS, or GCP) to enable resource generation."}
                      {" All credentials are stored securely in Bitwarden."}
                    </AlertDescription>
                  </div>
                  <Button 
                    onClick={() => setLocation('/settings')}
                    className="bg-amber-500 hover:bg-amber-600 text-white gap-2 shadow-lg shadow-amber-500/20 whitespace-nowrap"
                  >
                    Configure Now
                    <ArrowRight className="w-4 h-4" />
                  </Button>
                </div>
              </Alert>
            </motion.div>
          )}

          <div className="mb-8">
            <h2 className="text-3xl font-bold mb-2">What would you like to create?</h2>
            <p className="text-muted-foreground">
              {isConfigured 
                ? "Choose a DevOps automation to get started" 
                : "Setup your credentials to unlock all automation modules"}
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            <FeatureCard
              to="/terraform"
              icon={<FileCode className="w-6 h-6" />}
              title="Terraform"
              description="Generate infrastructure as code for Azure, AWS, or GCP using natural language"
              available={true}
              disabled={!isConfigured}
            />
            <FeatureCard
              to="/kubernetes"
              icon={<SettingsIcon className="w-6 h-6" />}
              title="Kubernetes"
              description="Create Kubernetes manifests and deployment configurations with AI assistance"
              available={true}
              disabled={!isConfigured}
            />
            <FeatureCard
              to="/automation"
              icon={<Terminal className="w-6 h-6" />}
              title="Automation Scripts"
              description="Build automation scripts for CI/CD pipelines and DevOps workflows"
              available={true}
              disabled={!isConfigured}
            />
            <FeatureCard
              to="/archme"
              icon={<Network className="w-6 h-6" />}
              title="ArchMe"
              description="Generate architecture diagrams from natural language requirements for Azure, AWS, GCP, and multi-cloud"
              available={true}
              disabled={!isConfigured}
            />
            <FeatureCard
              to="/docker"
              icon={<Package className="w-6 h-6" />}
              title="Docker"
              description="Generate optimized and secure Dockerfiles based on software requirements with AI assistance"
              available={true}
              disabled={!isConfigured}
            />
            <FeatureCard
              to="/scoreme"
              icon={<FileChartPie className="w-6 h-6" />}
              title="ScoreMe"
              description="Confidence report for IaC/automation files with actionable remediation hints"
              available={true}
              disabled={!isConfigured}
            />
          </div>
        </div>
      </main>
    </div>
  );
}
