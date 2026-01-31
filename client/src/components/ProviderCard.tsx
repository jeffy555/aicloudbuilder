import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface ProviderCardProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  onClick: () => void;
  selected?: boolean;
  provider?: 'github' | 'azure'; // Repository provider (GitHub/Azure DevOps)
  cloudProvider?: 'azure' | 'aws' | 'gcp'; // Cloud provider (Azure/AWS/GCP)
  fillBackground?: boolean; // Option to fill entire card background with color
}

export default function ProviderCard({ icon, title, description, onClick, selected = false, provider, cloudProvider, fillBackground = false }: ProviderCardProps) {
  // Determine colors based on cloud provider (takes precedence) or repository provider
  const isGitHub = provider === 'github' || title.toLowerCase().includes('github');
  const isAzureRepo = provider === 'azure' || (title.toLowerCase().includes('azure') && !cloudProvider);
  
  // Cloud provider colors: Azure (blue), AWS (yellow), GCP (green)
  const isAzureCloud = cloudProvider === 'azure' || (title.toLowerCase().includes('microsoft azure') || title.toLowerCase().includes('azure') && cloudProvider !== 'aws' && cloudProvider !== 'gcp');
  const isAWS = cloudProvider === 'aws' || title.toLowerCase().includes('amazon web services') || title.toLowerCase().includes('aws');
  const isGCP = cloudProvider === 'gcp' || title.toLowerCase().includes('google cloud platform') || title.toLowerCase().includes('gcp');
  
  // Icon background and text colors
  const iconBgColor = isAzureCloud
    ? "bg-blue-100 dark:bg-blue-900/30"
    : isAWS
    ? "bg-yellow-100 dark:bg-yellow-900/30"
    : isGCP
    ? "bg-green-100 dark:bg-green-900/30"
    : isGitHub 
    ? "bg-green-100 dark:bg-green-900/30" 
    : isAzureRepo
    ? "bg-blue-100 dark:bg-blue-900/30" 
    : "bg-primary/10";
  
  const iconTextColor = isAzureCloud
    ? "text-blue-600 dark:text-blue-400"
    : isAWS
    ? "text-yellow-600 dark:text-yellow-400"
    : isGCP
    ? "text-green-600 dark:text-green-400"
    : isGitHub 
    ? "text-green-600 dark:text-green-400" 
    : isAzureRepo
    ? "text-blue-600 dark:text-blue-400" 
    : "text-primary";
  
  // Border colors
  const borderColor = isAzureCloud
    ? selected ? "ring-2 ring-blue-500" : "border-blue-200 dark:border-blue-800"
    : isAWS
    ? selected ? "ring-2 ring-yellow-500" : "border-yellow-200 dark:border-yellow-800"
    : isGCP
    ? selected ? "ring-2 ring-green-500" : "border-green-200 dark:border-green-800"
    : isGitHub 
    ? selected ? "ring-2 ring-green-500" : "border-green-200 dark:border-green-800"
    : isAzureRepo
    ? selected ? "ring-2 ring-blue-500" : "border-blue-200 dark:border-blue-800"
    : selected ? "ring-2 ring-primary" : "";

  // Background color for entire card if fillBackground is true
  const cardBgColor = fillBackground 
    ? (isAzureCloud
        ? "bg-blue-50 dark:bg-blue-950/50"
        : isAWS
        ? "bg-yellow-50 dark:bg-yellow-950/50"
        : isGCP
        ? "bg-green-50 dark:bg-green-950/50"
        : isGitHub 
        ? "bg-green-50 dark:bg-green-950/50" 
        : isAzureRepo
        ? "bg-blue-50 dark:bg-blue-950/50" 
        : "")
    : "";

  // Text colors when background is filled
  const titleColor = fillBackground
    ? (isAzureCloud
        ? "text-blue-900 dark:text-blue-100"
        : isAWS
        ? "text-yellow-900 dark:text-yellow-100"
        : isGCP
        ? "text-green-900 dark:text-green-100"
        : isGitHub 
        ? "text-green-900 dark:text-green-100" 
        : isAzureRepo
        ? "text-blue-900 dark:text-blue-100" 
        : "")
    : "";
  
  const descriptionColor = fillBackground
    ? (isAzureCloud
        ? "text-blue-700 dark:text-blue-300"
        : isAWS
        ? "text-yellow-700 dark:text-yellow-300"
        : isGCP
        ? "text-green-700 dark:text-green-300"
        : isGitHub 
        ? "text-green-700 dark:text-green-300" 
        : isAzureRepo
        ? "text-blue-700 dark:text-blue-300" 
        : "")
    : "text-muted-foreground";

  return (
    <Card
      className={cn(
        "p-6 cursor-pointer transition-all hover-elevate active-elevate-2",
        borderColor,
        cardBgColor
      )}
      onClick={onClick}
      data-testid={`card-provider-${title.toLowerCase().replace(/\s+/g, '-')}`}
    >
      <div className="flex flex-col gap-4">
        <div className={cn("w-12 h-12 rounded-lg flex items-center justify-center", iconBgColor, iconTextColor)}>
          {icon}
        </div>
        <div>
          <h3 className={cn("text-lg font-medium mb-1", titleColor)}>{title}</h3>
          <p className={cn("text-sm", descriptionColor)}>{description}</p>
        </div>
      </div>
    </Card>
  );
}
