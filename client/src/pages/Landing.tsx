import { Link, useLocation } from "wouter";
import { motion } from "framer-motion";
import { useSecretsConfig } from "@/hooks/useSecretsConfig";
import {
  FileCode,
  Settings as SettingsIcon,
  Terminal,
  Network,
  Package,
  AlertTriangle,
  ArrowRight,
  FileChartPie,
  DollarSign,
  Sparkles
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import Header from "@/components/Header";

interface FeatureCardProps {
  to: string;
  icon: React.ReactNode;
  title: string;
  description: string;
  available: boolean;
  disabled?: boolean;
  gradient?: string;
  index?: number;
}

function FeatureCard({
  to,
  icon,
  title,
  description,
  available,
  disabled,
  gradient = "from-blue-500/10 to-purple-500/10",
  index = 0
}: FeatureCardProps) {
  const content = (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: index * 0.05 }}
      className="h-full"
    >
      <Card
        className={`
          group relative overflow-hidden h-full flex flex-col justify-between border-2
          transition-all duration-300 ease-in-out
          ${available && !disabled
            ? 'hover:border-primary/50 hover:shadow-2xl hover:shadow-primary/10 hover:-translate-y-1 cursor-pointer'
            : 'opacity-60 cursor-not-allowed border-muted'}
        `}
        data-testid={`card-feature-${title.toLowerCase()}`}
      >
        {/* Gradient background overlay */}
        <div className={`absolute inset-0 bg-gradient-to-br ${gradient} opacity-0 group-hover:opacity-100 transition-opacity duration-300`} />

        {/* Shimmer effect on hover */}
        {available && !disabled && (
          <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-1000" />
        )}

        <CardHeader className="relative z-10 pb-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className={`
                p-3 rounded-xl transition-all duration-300
                ${available && !disabled
                  ? 'bg-gradient-to-br from-primary/20 to-primary/10 group-hover:scale-110 group-hover:shadow-lg group-hover:shadow-primary/20'
                  : 'bg-muted'}
              `}>
                <div className={available && !disabled ? 'text-primary' : 'text-muted-foreground'}>
                  {icon}
                </div>
              </div>
              <div>
                <CardTitle className="text-lg font-bold">{title}</CardTitle>
                {!available && (
                  <Badge variant="outline" className="mt-1 text-xs">
                    Coming Soon
                  </Badge>
                )}
                {available && disabled && (
                  <Badge variant="outline" className="mt-1 text-xs border-amber-500 text-amber-600">
                    Setup Required
                  </Badge>
                )}
              </div>
            </div>
            {available && !disabled && (
              <ArrowRight className="w-5 h-5 text-muted-foreground group-hover:text-primary group-hover:translate-x-1 transition-all duration-300" />
            )}
          </div>
        </CardHeader>
        <CardContent className="relative z-10">
          <CardDescription className="text-sm leading-relaxed">
            {description}
          </CardDescription>
        </CardContent>
      </Card>
    </motion.div>
  );

  if (available && !disabled) {
    return <Link href={to}>{content}</Link>;
  }

  return content;
}

export default function Landing() {
  const [, setLocation] = useLocation();

  // Fetch secrets configuration status
  const { data: config, isLoading } = useSecretsConfig();

  const isConfigured = (config?.hasAzureDevOps || config?.hasGithub) && (config?.hasAzureCloud || config?.hasAws || config?.hasGcp);

  const missingRepos = !config?.hasAzureDevOps && !config?.hasGithub;
  const missingCloud = !config?.hasAzureCloud && !config?.hasAws && !config?.hasGcp;

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-muted/20">
      <Header />

      <main className="container mx-auto px-4 sm:px-6 lg:px-8 py-8 lg:py-12">
        <div className="max-w-7xl mx-auto">
          {/* Hero Section */}
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="text-center mb-10 lg:mb-16"
          >
            <div className="inline-flex items-center gap-2 mb-4 px-4 py-2 rounded-full bg-primary/10 border border-primary/20">
              <Sparkles className="w-4 h-4 text-primary" />
              <span className="text-sm font-medium text-primary">AI-Powered DevOps Automation</span>
            </div>
            <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold mb-4 bg-clip-text text-transparent bg-gradient-to-r from-foreground to-foreground/70">
              What would you like to create?
            </h1>
            <p className="text-lg md:text-xl text-muted-foreground max-w-2xl mx-auto">
              {isConfigured
                ? "Choose from our powerful automation tools to streamline your DevOps workflows"
                : "Setup your credentials to unlock all automation capabilities"}
            </p>
          </motion.div>

          {/* Configuration Alert */}
          {!isLoading && !isConfigured && (
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.3 }}
              className="mb-10"
            >
              <Alert className="border-2 border-amber-500/50 bg-gradient-to-r from-amber-50/50 to-orange-50/50 dark:from-amber-950/20 dark:to-orange-950/20 shadow-xl">
                <div className="absolute top-0 left-0 w-1.5 h-full bg-gradient-to-b from-amber-500 to-orange-500 rounded-l" />
                <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-500" />
                <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 w-full">
                  <div className="flex-1">
                    <AlertTitle className="text-amber-700 dark:text-amber-500 font-bold text-lg mb-2">
                      System Setup Required
                    </AlertTitle>
                    <AlertDescription className="text-muted-foreground">
                      {missingRepos && missingCloud
                        ? "Configure at least one Repository provider (GitHub/Azure DevOps) and one Cloud provider (Azure/AWS/GCP) to start using automation workflows."
                        : missingRepos
                          ? "Cloud provider configured! Now setup a Repository provider (GitHub or Azure DevOps) to store your code."
                          : "Repository configured! Now setup Cloud credentials (Azure, AWS, or GCP) to enable resource generation."}
                      {" "}All credentials are stored securely in Bitwarden.
                    </AlertDescription>
                  </div>
                  <Button
                    onClick={() => setLocation('/settings')}
                    size="lg"
                    className="bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-white border-0 shadow-lg hover:shadow-xl transition-all duration-300 whitespace-nowrap"
                  >
                    Configure Now
                    <ArrowRight className="w-4 h-4 ml-2" />
                  </Button>
                </div>
              </Alert>
            </motion.div>
          )}

          {/* Infrastructure & Code Section */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5, delay: 0.2 }}
            className="mb-12"
          >
            <div className="mb-6">
              <h2 className="text-2xl font-bold mb-2">Infrastructure & Code Generation</h2>
              <p className="text-muted-foreground">Transform your requirements into production-ready infrastructure code</p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 lg:gap-6">
              <FeatureCard
                to="/terraform"
                icon={<FileCode className="w-6 h-6" />}
                title="Terraform"
                description="Generate infrastructure as code for Azure, AWS, or GCP using natural language"
                available={true}
                disabled={!isConfigured}
                gradient="from-purple-500/10 via-blue-500/10 to-purple-500/10"
                index={0}
              />
              <FeatureCard
                to="/kubernetes"
                icon={<SettingsIcon className="w-6 h-6" />}
                title="Kubernetes"
                description="Create Kubernetes manifests and deployment configurations with AI assistance"
                available={true}
                disabled={!isConfigured}
                gradient="from-blue-500/10 via-cyan-500/10 to-blue-500/10"
                index={1}
              />
              <FeatureCard
                to="/docker"
                icon={<Package className="w-6 h-6" />}
                title="Docker"
                description="Generate optimized and secure Dockerfiles based on software requirements with AI assistance"
                available={true}
                disabled={!isConfigured}
                gradient="from-cyan-500/10 via-teal-500/10 to-cyan-500/10"
                index={2}
              />
            </div>
          </motion.div>

          {/* Architecture & Automation Section */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5, delay: 0.3 }}
            className="mb-12"
          >
            <div className="mb-6">
              <h2 className="text-2xl font-bold mb-2">Architecture & Automation</h2>
              <p className="text-muted-foreground">Design, automate, and streamline your DevOps workflows</p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 lg:gap-6">
              <FeatureCard
                to="/archme"
                icon={<Network className="w-6 h-6" />}
                title="ArchMe"
                description="Generate architecture diagrams from natural language requirements for Azure, AWS, GCP, and multi-cloud"
                available={true}
                disabled={!isConfigured}
                gradient="from-green-500/10 via-emerald-500/10 to-green-500/10"
                index={3}
              />
              <FeatureCard
                to="/automation"
                icon={<Terminal className="w-6 h-6" />}
                title="Automation Scripts"
                description="Build automation scripts for CI/CD pipelines and DevOps workflows"
                available={true}
                disabled={!isConfigured}
                gradient="from-orange-500/10 via-amber-500/10 to-orange-500/10"
                index={4}
              />
            </div>
          </motion.div>

          {/* Analysis & Optimization Section */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5, delay: 0.4 }}
          >
            <div className="mb-6">
              <h2 className="text-2xl font-bold mb-2">Analysis & Optimization</h2>
              <p className="text-muted-foreground">Optimize costs and validate your infrastructure quality</p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 lg:gap-6">
              <FeatureCard
                to="/valuation"
                icon={<DollarSign className="w-6 h-6" />}
                title="Valuation"
                description="Analyze live Azure resources and identify cost optimization opportunities with SKU recommendations"
                available={true}
                disabled={!config?.hasAzureCloud}
                gradient="from-emerald-500/10 via-green-500/10 to-emerald-500/10"
                index={5}
              />
              <FeatureCard
                to="/scoreme"
                icon={<FileChartPie className="w-6 h-6" />}
                title="ScoreMe"
                description="Confidence report for IaC/automation files with actionable remediation hints"
                available={true}
                disabled={!isConfigured}
                gradient="from-pink-500/10 via-rose-500/10 to-pink-500/10"
                index={6}
              />
            </div>
          </motion.div>
        </div>
      </main>
    </div>
  );
}
