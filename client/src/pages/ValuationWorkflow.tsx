import { useState, useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import Header from "@/components/Header";
import StepIndicator from "@/components/StepIndicator";
import ValuationResourceTable from "@/components/ValuationResourceTable";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, Home, Wallet, TrendingDown, Package, Lightbulb } from "lucide-react";
import type { Session, ValuationSummary, ValuationResource, ResourceGroupSummary } from "@shared/schema";

type Step = 1 | 2 | 3 | 4 | 5;

export default function ValuationWorkflow() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [sessionId, setSessionId] = useState<string>('');
  const [currentStep, setCurrentStep] = useState<Step>(1);
  const [resourceGroups, setResourceGroups] = useState<ResourceGroupSummary[]>([]);
  const [selectedRgIds, setSelectedRgIds] = useState<string[]>([]);
  const [analysisResult, setAnalysisResult] = useState<{
    summary: ValuationSummary;
    resources: ValuationResource[];
  } | null>(null);

  const steps = [
    { number: 1, title: 'Connect' },
    { number: 2, title: 'Select Resource Groups' },
    { number: 3, title: 'Scan Resources' },
    { number: 4, title: 'Analyze & Fetch Metrics' },
    { number: 5, title: 'Results' }
  ];

  // Session initialization
  useEffect(() => {
    const initSession = async () => {
      const savedId = localStorage.getItem('valuation_workflow_session_id');
      if (savedId) {
        try {
          const response = await apiRequest('GET', `/api/sessions/${savedId}`);
          const session = await response.json() as Session;
          setSessionId(session.id);
          return;
        } catch {
          localStorage.removeItem('valuation_workflow_session_id');
        }
      }

      const response = await apiRequest('POST', '/api/sessions');
      const session = await response.json() as Session;
      setSessionId(session.id);
      localStorage.setItem('valuation_workflow_session_id', session.id);
      await apiRequest('PATCH', `/api/sessions/${session.id}`, {
        activeModule: 'valuation'
      });
    };

    initSession();
  }, []);

  // Fetch resource groups mutation
  const fetchRgMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest('POST', '/api/valuation/resource-groups', { sessionId });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.details || errorData.error || 'Failed to fetch resource groups');
      }
      return response.json();
    },
    onSuccess: (data) => {
      setResourceGroups(data.resourceGroups || []);
      setCurrentStep(2);
      toast({
        title: "Resource Groups Loaded",
        description: `Found ${data.resourceGroups?.length || 0} resource group(s).`
      });
    },
    onError: (error: any) => {
      console.error('Resource groups error:', error);
      toast({
        title: "Failed to Load Resource Groups",
        description: error.message || "Could not fetch resource groups. Check console for details.",
        variant: "destructive"
      });
      // Stay on step 1 if RG fetch fails
      setCurrentStep(1);
    }
  });

  // Connect mutation
  const connectMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest('POST', '/api/valuation/connect', { sessionId });
      return response.json();
    },
    onSuccess: () => {
      toast({
        title: "Connection Successful",
        description: "Azure credentials verified successfully."
      });
      // Automatically fetch resource groups after connection
      fetchRgMutation.mutate();
    },
    onError: (error: any) => {
      toast({
        title: "Connection Failed",
        description: error.message || "Could not connect to Azure. Please check your credentials.",
        variant: "destructive"
      });
    }
  });

  // Scan mutation
  const scanMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest('POST', '/api/valuation/scan', {
        sessionId,
        resourceGroupIds: selectedRgIds.length > 0 ? selectedRgIds : undefined
      });
      return response.json();
    },
    onSuccess: (data) => {
      setCurrentStep(4);
      toast({
        title: "Scan Complete",
        description: `Found ${data.scannedCount} resource(s).`
      });
    },
    onError: (error: any) => {
      toast({
        title: "Scan Failed",
        description: error.message || "Could not fetch resources from Azure.",
        variant: "destructive"
      });
    }
  });

  // Analyze mutation
  const analyzeMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest('POST', '/api/valuation/analyze', {
        sessionId,
        fetchMetrics: true
      });
      return response.json();
    },
    onSuccess: (data) => {
      setAnalysisResult(data);
      setCurrentStep(5);
      toast({
        title: "Analysis Complete",
        description: `Analyzed ${data.summary.resourceCount} resource(s). Found ${data.summary.recommendationCount} optimization(s).`
      });
    },
    onError: (error: any) => {
      toast({
        title: "Analysis Failed",
        description: error.message || "Could not analyze costs.",
        variant: "destructive"
      });
    }
  });

  return (
    <div className="min-h-screen bg-background">
      <Header />

      <div className="container mx-auto px-6 py-12">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold">Valuation Workflow</h1>
            <p className="text-muted-foreground mt-1">
              Analyze live Azure resources and identify cost savings
            </p>
          </div>
          <Button variant="outline" onClick={() => setLocation("/")}>
            <Home className="w-4 h-4 mr-2" />
            Home
          </Button>
        </div>

        <StepIndicator steps={steps} currentStep={currentStep} />

        <div className="max-w-4xl mx-auto mt-8">
          {/* Step 1: Connect */}
          {currentStep === 1 && (
            <Card>
              <CardHeader>
                <CardTitle>Connect to Azure</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-muted-foreground">
                  Verify your Azure credentials and test connection to your subscription.
                </p>
                <Button
                  onClick={() => connectMutation.mutate()}
                  disabled={connectMutation.isPending}
                >
                  {connectMutation.isPending && (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  )}
                  Test Connection
                </Button>
              </CardContent>
            </Card>
          )}

          {/* Step 2: Select Resource Groups */}
          {currentStep === 2 && (
            <Card>
              <CardHeader>
                <CardTitle>Select Resource Groups</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-muted-foreground">
                  Choose which resource groups to analyze. Select all or filter by specific groups.
                </p>

                {fetchRgMutation.isPending ? (
                  <div className="flex items-center gap-2 py-8">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span className="text-sm text-muted-foreground">Loading resource groups...</span>
                  </div>
                ) : (
                  <>
                    <div className="flex gap-4 mb-4">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setSelectedRgIds(resourceGroups.map(rg => rg.id))}
                      >
                        Select All
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setSelectedRgIds([])}
                      >
                        Deselect All
                      </Button>
                      <Badge variant="secondary">
                        {selectedRgIds.length} of {resourceGroups.length} selected
                      </Badge>
                    </div>

                    <div className="border rounded-lg divide-y max-h-96 overflow-y-auto">
                      {resourceGroups.map((rg) => (
                        <label
                          key={rg.id}
                          className="flex items-center gap-3 p-3 hover:bg-slate-50 dark:hover:bg-slate-900 cursor-pointer transition-colors"
                        >
                          <input
                            type="checkbox"
                            checked={selectedRgIds.includes(rg.id)}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setSelectedRgIds([...selectedRgIds, rg.id]);
                              } else {
                                setSelectedRgIds(selectedRgIds.filter(id => id !== rg.id));
                              }
                            }}
                            className="w-4 h-4 rounded border-gray-300"
                          />
                          <div className="flex-1">
                            <div className="font-medium">{rg.name}</div>
                            <div className="text-xs text-muted-foreground">
                              {rg.location} • {rg.resourceCount} resource(s)
                            </div>
                          </div>
                        </label>
                      ))}
                    </div>

                    <Button
                      onClick={() => scanMutation.mutate()}
                      disabled={selectedRgIds.length === 0 || scanMutation.isPending}
                      className="mt-4"
                    >
                      {scanMutation.isPending && (
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      )}
                      Continue to Scan
                    </Button>
                  </>
                )}
              </CardContent>
            </Card>
          )}

          {/* Step 3: Scan Resources */}
          {currentStep === 3 && (
            <Card>
              <CardHeader>
                <CardTitle>Scan Resources</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-muted-foreground">
                  Fetching resources from selected resource groups...
                </p>
                <div className="flex items-center gap-2 py-8">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span className="text-sm text-muted-foreground">Scanning in progress...</span>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Step 4: Analyze & Fetch Metrics */}
          {currentStep === 4 && (
            <Card>
              <CardHeader>
                <CardTitle>Analyze Costs & Fetch Metrics</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-muted-foreground">
                  Calculate costs using Azure Retail Pricing API and fetch usage metrics from Azure Monitor for accurate recommendations.
                </p>
                <Button
                  onClick={() => analyzeMutation.mutate()}
                  disabled={analyzeMutation.isPending}
                >
                  {analyzeMutation.isPending && (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  )}
                  Analyze & Fetch Metrics
                </Button>
              </CardContent>
            </Card>
          )}

          {/* Step 5: Results */}
          {currentStep === 5 && analysisResult && (
            <div className="space-y-8">
              {/* Summary Cards */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                {/* Total Monthly Cost Card */}
                <Card className="relative overflow-hidden border-2 border-blue-200 dark:border-blue-800 bg-gradient-to-br from-blue-50 to-white dark:from-blue-950/20 dark:to-background shadow-lg hover:shadow-xl transition-shadow">
                  <div className="absolute top-0 right-0 w-24 h-24 bg-blue-500/10 rounded-full -mr-12 -mt-12" />
                  <CardHeader className="pb-3">
                    <div className="flex items-center gap-3">
                      <div className="p-3 rounded-xl bg-blue-500/20">
                        <Wallet className="w-5 h-5 text-blue-600 dark:text-blue-400" />
                      </div>
                      <CardTitle className="text-sm font-semibold text-blue-700 dark:text-blue-300">
                        Total Monthly Cost
                      </CardTitle>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <p className="text-3xl font-bold text-blue-900 dark:text-blue-100">
                      ₹{analysisResult.summary.totalMonthlyCost.toFixed(2)}
                    </p>
                  </CardContent>
                </Card>

                {/* Potential Savings Card */}
                <Card className="relative overflow-hidden border-2 border-emerald-200 dark:border-emerald-800 bg-gradient-to-br from-emerald-50 to-white dark:from-emerald-950/20 dark:to-background shadow-lg hover:shadow-xl transition-shadow">
                  <div className="absolute top-0 right-0 w-24 h-24 bg-emerald-500/10 rounded-full -mr-12 -mt-12" />
                  <CardHeader className="pb-3">
                    <div className="flex items-center gap-3">
                      <div className="p-3 rounded-xl bg-emerald-500/20">
                        <TrendingDown className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
                      </div>
                      <CardTitle className="text-sm font-semibold text-emerald-700 dark:text-emerald-300">
                        Potential Savings
                      </CardTitle>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <p className="text-3xl font-bold text-emerald-900 dark:text-emerald-100">
                      ₹{analysisResult.summary.potentialSavings.toFixed(2)}
                    </p>
                    <div className="mt-2 inline-flex items-center gap-1 px-2 py-1 rounded-full bg-emerald-100 dark:bg-emerald-900/30">
                      <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-300">
                        {analysisResult.summary.savingsPercent}% savings
                      </span>
                    </div>
                  </CardContent>
                </Card>

                {/* Resources Scanned Card */}
                <Card className="relative overflow-hidden border-2 border-purple-200 dark:border-purple-800 bg-gradient-to-br from-purple-50 to-white dark:from-purple-950/20 dark:to-background shadow-lg hover:shadow-xl transition-shadow">
                  <div className="absolute top-0 right-0 w-24 h-24 bg-purple-500/10 rounded-full -mr-12 -mt-12" />
                  <CardHeader className="pb-3">
                    <div className="flex items-center gap-3">
                      <div className="p-3 rounded-xl bg-purple-500/20">
                        <Package className="w-5 h-5 text-purple-600 dark:text-purple-400" />
                      </div>
                      <CardTitle className="text-sm font-semibold text-purple-700 dark:text-purple-300">
                        Resources Scanned
                      </CardTitle>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <p className="text-3xl font-bold text-purple-900 dark:text-purple-100">
                      {analysisResult.summary.resourceCount}
                    </p>
                  </CardContent>
                </Card>

                {/* Recommendations Card */}
                <Card className="relative overflow-hidden border-2 border-amber-200 dark:border-amber-800 bg-gradient-to-br from-amber-50 to-white dark:from-amber-950/20 dark:to-background shadow-lg hover:shadow-xl transition-shadow">
                  <div className="absolute top-0 right-0 w-24 h-24 bg-amber-500/10 rounded-full -mr-12 -mt-12" />
                  <CardHeader className="pb-3">
                    <div className="flex items-center gap-3">
                      <div className="p-3 rounded-xl bg-amber-500/20">
                        <Lightbulb className="w-5 h-5 text-amber-600 dark:text-amber-400" />
                      </div>
                      <CardTitle className="text-sm font-semibold text-amber-700 dark:text-amber-300">
                        Recommendations
                      </CardTitle>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <p className="text-3xl font-bold text-amber-900 dark:text-amber-100">
                      {analysisResult.summary.recommendationCount}
                    </p>
                  </CardContent>
                </Card>
              </div>

              {/* Resource Table */}
              <ValuationResourceTable resources={analysisResult.resources} />

              {/* Action Buttons */}
              <div className="flex justify-between">
                <Button variant="outline" onClick={() => setCurrentStep(1)}>
                  Start New Analysis
                </Button>
                <Button variant="outline" onClick={() => setLocation("/")}>
                  Return Home
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
