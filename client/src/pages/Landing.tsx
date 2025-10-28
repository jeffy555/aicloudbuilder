import { Link } from "wouter";
import { FileCode, Settings, Terminal } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface FeatureCardProps {
  to: string;
  icon: React.ReactNode;
  title: string;
  description: string;
  available: boolean;
}

function FeatureCard({ to, icon, title, description, available }: FeatureCardProps) {
  const content = (
    <Card 
      className={`transition-all ${available ? 'hover-elevate active-elevate-2 cursor-pointer' : 'opacity-60 cursor-not-allowed'}`}
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

  if (available) {
    return <Link href={to}>{content}</Link>;
  }

  return <div>{content}</div>;
}

export default function Landing() {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="container mx-auto px-6 py-4">
          <h1 className="text-2xl font-bold">AI-Driven DevOps Platform</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Generate and manage infrastructure code with AI
          </p>
        </div>
      </header>

      <main className="container mx-auto px-6 py-12">
        <div className="max-w-5xl mx-auto">
          <div className="mb-8">
            <h2 className="text-3xl font-bold mb-2">What would you like to create?</h2>
            <p className="text-muted-foreground">
              Choose a DevOps automation to get started
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            <FeatureCard
              to="/terraform"
              icon={<FileCode className="w-6 h-6" />}
              title="Terraform"
              description="Generate infrastructure as code for Azure, AWS, or GCP using natural language"
              available={true}
            />
            <FeatureCard
              to="/kubernetes"
              icon={<Settings className="w-6 h-6" />}
              title="Kubernetes"
              description="Create Kubernetes manifests and deployment configurations with AI assistance"
              available={false}
            />
            <FeatureCard
              to="/automation"
              icon={<Terminal className="w-6 h-6" />}
              title="Automation Scripts"
              description="Build automation scripts for CI/CD pipelines and DevOps workflows"
              available={false}
            />
          </div>
        </div>
      </main>
    </div>
  );
}
