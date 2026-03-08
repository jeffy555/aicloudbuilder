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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Loader2, Home, Wallet, TrendingDown, Package, Lightbulb, Shield, Globe, Bell, Check, Trophy } from "lucide-react";
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

  // FinOps tab state
  const [activeResultTab, setActiveResultTab] = useState<string>('cost');
  const [riResult, setRiResult] = useState<any>(null);
  const [budgetResult, setBudgetResult] = useState<any>(null);
  const [multiCloudResult, setMultiCloudResult] = useState<any>(null);
  const [budgetAmount, setBudgetAmount] = useState<string>('');
  const [budgetEmails, setBudgetEmails] = useState<string>('');
  const [budgetThresholds, setBudgetThresholds] = useState<number[]>([80, 100, 120]);

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

  // FinOps: Reserved Instance advisor
  const riMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest('POST', '/api/valuation/reserved-instances', {
        resources: analysisResult?.resources ?? [],
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.details || err.error || 'Failed to analyse reserved instances');
      }
      return response.json();
    },
    onSuccess: (data) => {
      setRiResult(data);
      toast({ title: 'Reserved Instance Analysis Complete', description: `${data.eligibleCount} eligible resource(s) found` });
    },
    onError: (error: any) => {
      toast({ title: 'RI Analysis Failed', description: error.message, variant: 'destructive' });
    },
  });

  // FinOps: Budget alert — creates real Azure budget via Cost Management API
  const budgetMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest('POST', '/api/valuation/budget-alerts', {
        sessionId,
        monthlyBudget: parseFloat(budgetAmount) || analysisResult?.summary.totalMonthlyCost || 0,
        emails: budgetEmails,
        thresholds: budgetThresholds,
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.details || err.error || 'Failed to create budget alert');
      }
      return response.json();
    },
    onSuccess: (data) => {
      setBudgetResult(data);
      toast({ title: 'Budget Alert Created', description: `"${data.budgetName}" created on ${data.scope}` });
    },
    onError: (error: any) => {
      toast({ title: 'Budget Creation Failed', description: error.message, variant: 'destructive' });
    },
  });

  // FinOps: Multi-cloud comparator
  const multiCloudMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest('POST', '/api/valuation/multicloud-compare', {
        resources: analysisResult?.resources ?? [],
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.details || err.error || 'Failed to compare cloud prices');
      }
      return response.json();
    },
    onSuccess: (data) => {
      setMultiCloudResult(data);
      toast({ title: 'Multi-Cloud Comparison Complete', description: `${data.resourceCount} resource(s) compared. Cheapest: ${data.cheapestProvider.toUpperCase()}` });
    },
    onError: (error: any) => {
      toast({ title: 'Multi-Cloud Comparison Failed', description: error.message, variant: 'destructive' });
    },
  });


  const toggleThreshold = (t: number) => {
    setBudgetThresholds(prev =>
      prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t].sort((a, b) => a - b)
    );
  };

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
            <div className="space-y-6">
              {/* Summary Cards */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                <Card className="relative overflow-hidden border-2 border-blue-200 dark:border-blue-800 bg-gradient-to-br from-blue-50 to-white dark:from-blue-950/20 dark:to-background shadow-lg">
                  <div className="absolute top-0 right-0 w-24 h-24 bg-blue-500/10 rounded-full -mr-12 -mt-12" />
                  <CardHeader className="pb-3">
                    <div className="flex items-center gap-3">
                      <div className="p-3 rounded-xl bg-blue-500/20">
                        <Wallet className="w-5 h-5 text-blue-600 dark:text-blue-400" />
                      </div>
                      <CardTitle className="text-sm font-semibold text-blue-700 dark:text-blue-300">Total Monthly Cost</CardTitle>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <p className="text-3xl font-bold text-blue-900 dark:text-blue-100">₹{analysisResult.summary.totalMonthlyCost.toFixed(2)}</p>
                  </CardContent>
                </Card>

                <Card className="relative overflow-hidden border-2 border-emerald-200 dark:border-emerald-800 bg-gradient-to-br from-emerald-50 to-white dark:from-emerald-950/20 dark:to-background shadow-lg">
                  <div className="absolute top-0 right-0 w-24 h-24 bg-emerald-500/10 rounded-full -mr-12 -mt-12" />
                  <CardHeader className="pb-3">
                    <div className="flex items-center gap-3">
                      <div className="p-3 rounded-xl bg-emerald-500/20">
                        <TrendingDown className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
                      </div>
                      <CardTitle className="text-sm font-semibold text-emerald-700 dark:text-emerald-300">Potential Savings</CardTitle>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <p className="text-3xl font-bold text-emerald-900 dark:text-emerald-100">₹{analysisResult.summary.potentialSavings.toFixed(2)}</p>
                    <div className="mt-2 inline-flex items-center gap-1 px-2 py-1 rounded-full bg-emerald-100 dark:bg-emerald-900/30">
                      <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-300">{analysisResult.summary.savingsPercent}% savings</span>
                    </div>
                  </CardContent>
                </Card>

                <Card className="relative overflow-hidden border-2 border-purple-200 dark:border-purple-800 bg-gradient-to-br from-purple-50 to-white dark:from-purple-950/20 dark:to-background shadow-lg">
                  <div className="absolute top-0 right-0 w-24 h-24 bg-purple-500/10 rounded-full -mr-12 -mt-12" />
                  <CardHeader className="pb-3">
                    <div className="flex items-center gap-3">
                      <div className="p-3 rounded-xl bg-purple-500/20">
                        <Package className="w-5 h-5 text-purple-600 dark:text-purple-400" />
                      </div>
                      <CardTitle className="text-sm font-semibold text-purple-700 dark:text-purple-300">Resources Scanned</CardTitle>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <p className="text-3xl font-bold text-purple-900 dark:text-purple-100">{analysisResult.summary.resourceCount}</p>
                  </CardContent>
                </Card>

                <Card className="relative overflow-hidden border-2 border-amber-200 dark:border-amber-800 bg-gradient-to-br from-amber-50 to-white dark:from-amber-950/20 dark:to-background shadow-lg">
                  <div className="absolute top-0 right-0 w-24 h-24 bg-amber-500/10 rounded-full -mr-12 -mt-12" />
                  <CardHeader className="pb-3">
                    <div className="flex items-center gap-3">
                      <div className="p-3 rounded-xl bg-amber-500/20">
                        <Lightbulb className="w-5 h-5 text-amber-600 dark:text-amber-400" />
                      </div>
                      <CardTitle className="text-sm font-semibold text-amber-700 dark:text-amber-300">Recommendations</CardTitle>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <p className="text-3xl font-bold text-amber-900 dark:text-amber-100">{analysisResult.summary.recommendationCount}</p>
                  </CardContent>
                </Card>
              </div>

              {/* 4-Tab FinOps Results */}
              <Tabs value={activeResultTab} onValueChange={setActiveResultTab}>
                <TabsList className="grid w-full grid-cols-4">
                  <TabsTrigger value="cost" className="flex items-center gap-2">
                    <Wallet className="w-4 h-4" /> Cost & Rightsizing
                  </TabsTrigger>
                  <TabsTrigger value="reserved" className="flex items-center gap-2">
                    <Shield className="w-4 h-4" /> Reserved Instances
                  </TabsTrigger>
                  <TabsTrigger value="budget" className="flex items-center gap-2">
                    <Bell className="w-4 h-4" /> Budget Alerts
                  </TabsTrigger>
                  <TabsTrigger value="multicloud" className="flex items-center gap-2">
                    <Globe className="w-4 h-4" /> Multi-Cloud
                  </TabsTrigger>
                </TabsList>

                {/* Tab 1: Cost & Rightsizing (existing) */}
                <TabsContent value="cost" className="mt-4">
                  <ValuationResourceTable resources={analysisResult.resources} />
                </TabsContent>

                {/* Tab 2: Reserved Instances */}
                <TabsContent value="reserved" className="mt-4">
                  <Card>
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2">
                        <Shield className="w-5 h-5 text-blue-600" />
                        Reserved Instance Advisor
                      </CardTitle>
                      <p className="text-sm text-muted-foreground">
                        Commit to 1-year or 3-year reserved pricing to reduce costs by 31–58% on eligible resources.
                      </p>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      {!riResult && (
                        <Button onClick={() => riMutation.mutate()} disabled={riMutation.isPending}>
                          {riMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                          Analyse Reserved Pricing
                        </Button>
                      )}

                      {riResult && (
                        <div className="space-y-4">
                          {/* RI Summary Banner */}
                          {riResult.eligibleCount > 0 && (
                            <div className="rounded-xl border-2 border-emerald-200 bg-emerald-50 dark:bg-emerald-950/20 p-4 flex items-center justify-between">
                              <div>
                                <p className="font-semibold text-emerald-800 dark:text-emerald-200">
                                  Save ₹{riResult.totalSavingMonthly.toFixed(0)}/month by switching to reserved pricing
                                </p>
                                <p className="text-sm text-emerald-700 dark:text-emerald-300">
                                  ₹{riResult.totalSavingAnnual.toFixed(0)}/year across {riResult.eligibleCount} eligible resource(s)
                                </p>
                              </div>
                              <div className="text-right">
                                <p className="text-2xl font-bold text-emerald-700">
                                  {Math.round((riResult.totalSavingMonthly / riResult.totalOnDemandMonthly) * 100)}%
                                </p>
                                <p className="text-xs text-emerald-600">avg saving</p>
                              </div>
                            </div>
                          )}

                          {riResult.eligibleCount === 0 && (
                            <p className="text-sm text-muted-foreground py-4 text-center">
                              No eligible resources found. Reserved pricing applies to VMs, AKS, App Service, and managed databases.
                            </p>
                          )}

                          {/* RI Table */}
                          {riResult.recommendations.length > 0 && (
                            <div className="overflow-x-auto rounded-lg border">
                              <table className="w-full text-sm">
                                <thead className="bg-muted/50">
                                  <tr>
                                    <th className="text-left p-3 font-medium">Resource</th>
                                    <th className="text-left p-3 font-medium">SKU</th>
                                    <th className="text-right p-3 font-medium">On-Demand</th>
                                    <th className="text-right p-3 font-medium">1-Year RI</th>
                                    <th className="text-right p-3 font-medium">3-Year RI</th>
                                    <th className="text-right p-3 font-medium">Annual Save</th>
                                    <th className="text-center p-3 font-medium">Signal</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y">
                                  {riResult.recommendations.map((rec: any, i: number) => (
                                    <tr key={i} className="hover:bg-muted/30">
                                      <td className="p-3 font-medium">{rec.resourceName}</td>
                                      <td className="p-3 text-muted-foreground font-mono text-xs">{rec.currentSku}</td>
                                      <td className="p-3 text-right">₹{rec.onDemandMonthly.toFixed(0)}</td>
                                      <td className="p-3 text-right text-emerald-600 font-medium">
                                        ₹{rec.reservedMonthly1Yr.toFixed(0)}
                                        <span className="ml-1 text-xs text-muted-foreground">(-{rec.saving1YrPercent}%)</span>
                                      </td>
                                      <td className="p-3 text-right text-emerald-700 font-medium">
                                        ₹{rec.reservedMonthly3Yr.toFixed(0)}
                                        <span className="ml-1 text-xs text-muted-foreground">(-{rec.saving3YrPercent}%)</span>
                                      </td>
                                      <td className="p-3 text-right font-semibold text-emerald-600">₹{rec.saving1YrAnnual.toFixed(0)}</td>
                                      <td className="p-3 text-center">
                                        <Badge variant={rec.recommendation === 'strong' ? 'default' : rec.recommendation === 'moderate' ? 'secondary' : 'outline'}
                                          className={rec.recommendation === 'strong' ? 'bg-emerald-600' : ''}>
                                          {rec.recommendation}
                                        </Badge>
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}

                          <Button variant="outline" size="sm" onClick={() => { setRiResult(null); riMutation.reset(); }}>
                            Re-analyse
                          </Button>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </TabsContent>

                {/* Tab 3: Budget Alerts */}
                <TabsContent value="budget" className="mt-4">
                  <Card>
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2">
                        <Bell className="w-5 h-5 text-amber-600" />
                        Azure Budget Alert
                      </CardTitle>
                      <p className="text-sm text-muted-foreground">
                        Create a real Azure Cost Management budget alert on your live subscription. You will receive email notifications when spend crosses the configured thresholds.
                      </p>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      {!budgetResult && (
                        <div className="space-y-4 max-w-lg">
                          <div className="space-y-1">
                            <label className="text-sm font-medium">Monthly Budget (USD)</label>
                            <input
                              type="number"
                              value={budgetAmount}
                              onChange={e => setBudgetAmount(e.target.value)}
                              placeholder={`${analysisResult.summary.totalMonthlyCost.toFixed(0)} (current spend)`}
                              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            />
                            <p className="text-xs text-muted-foreground">Leave blank to use your current monthly spend as the budget ceiling</p>
                          </div>

                          <div className="space-y-1">
                            <label className="text-sm font-medium">Notification Emails</label>
                            <input
                              type="text"
                              value={budgetEmails}
                              onChange={e => setBudgetEmails(e.target.value)}
                              placeholder="devops@company.com, cto@company.com"
                              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            />
                            <p className="text-xs text-muted-foreground">Comma-separated. Leave blank if you will configure contacts in the portal.</p>
                          </div>

                          <div className="space-y-2">
                            <label className="text-sm font-medium">Alert Thresholds</label>
                            <div className="flex flex-wrap gap-3">
                              {[50, 80, 100, 120].map(t => (
                                <label key={t} className="flex items-center gap-2 text-sm cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={budgetThresholds.includes(t)}
                                    onChange={() => toggleThreshold(t)}
                                    className="rounded"
                                  />
                                  {t}%
                                </label>
                              ))}
                            </div>
                          </div>

                          <Button onClick={() => budgetMutation.mutate()} disabled={budgetMutation.isPending}>
                            {budgetMutation.isPending
                              ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Creating in Azure...</>
                              : <><Bell className="w-4 h-4 mr-2" />Create Budget Alert</>
                            }
                          </Button>
                        </div>
                      )}

                      {budgetResult && (
                        <div className="space-y-4">
                          {/* Success banner */}
                          <div className="rounded-xl border border-emerald-200 bg-emerald-50 dark:bg-emerald-950/20 p-4 flex items-start gap-3">
                            <Check className="w-5 h-5 text-emerald-600 mt-0.5 shrink-0" />
                            <div>
                              <p className="font-semibold text-emerald-800 dark:text-emerald-200">Budget Alert Created Successfully</p>
                              <p className="text-xs text-emerald-700 dark:text-emerald-300 mt-0.5">
                                The budget is now live in Azure Cost Management and will trigger notifications automatically.
                              </p>
                            </div>
                          </div>

                          {/* Details grid */}
                          <div className="grid grid-cols-2 gap-3">
                            <div className="rounded-lg border p-3 space-y-0.5">
                              <p className="text-xs text-muted-foreground uppercase tracking-wide">Budget Name</p>
                              <p className="text-sm font-mono font-medium">{budgetResult.budgetName}</p>
                            </div>
                            <div className="rounded-lg border p-3 space-y-0.5">
                              <p className="text-xs text-muted-foreground uppercase tracking-wide">Monthly Limit</p>
                              <p className="text-sm font-semibold">${budgetResult.amount.toLocaleString()}</p>
                            </div>
                            <div className="rounded-lg border p-3 space-y-0.5">
                              <p className="text-xs text-muted-foreground uppercase tracking-wide">Scope</p>
                              <p className="text-sm font-medium">{budgetResult.scope}</p>
                            </div>
                            <div className="rounded-lg border p-3 space-y-0.5">
                              <p className="text-xs text-muted-foreground uppercase tracking-wide">Alert Thresholds</p>
                              <p className="text-sm font-medium">{(budgetResult.thresholds as number[]).map(t => `${t}%`).join(', ')}</p>
                            </div>
                            {budgetResult.emailCount > 0 && (
                              <div className="rounded-lg border p-3 space-y-0.5 col-span-2">
                                <p className="text-xs text-muted-foreground uppercase tracking-wide">Notification Recipients</p>
                                <p className="text-sm">{(budgetResult.emails as string[]).join(', ')}</p>
                              </div>
                            )}
                          </div>

                          <a
                            href={budgetResult.portalUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-2 text-sm text-primary hover:underline"
                          >
                            <Globe className="w-4 h-4" />
                            View in Azure Cost Management Portal
                          </a>

                          <Button variant="outline" size="sm" onClick={() => { setBudgetResult(null); budgetMutation.reset(); }}>
                            Create Another Budget
                          </Button>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </TabsContent>

                {/* Tab 4: Multi-Cloud Compare */}
                <TabsContent value="multicloud" className="mt-4">
                  <Card>
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2">
                        <Globe className="w-5 h-5 text-purple-600" />
                        Multi-Cloud Price Comparison
                      </CardTitle>
                      <p className="text-sm text-muted-foreground">
                        Estimate the cost of running the same workload on AWS and GCP using equivalent service tiers.
                      </p>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      {!multiCloudResult && (
                        <Button onClick={() => multiCloudMutation.mutate()} disabled={multiCloudMutation.isPending}>
                          {multiCloudMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                          Compare Cloud Prices
                        </Button>
                      )}

                      {multiCloudResult && (
                        <div className="space-y-4">
                          {/* Totals Banner */}
                          <div className="grid grid-cols-3 gap-3">
                            {(['azure', 'aws', 'gcp'] as const).map(provider => {
                              const labels: Record<string, string> = { azure: 'Microsoft Azure', aws: 'Amazon AWS', gcp: 'Google Cloud' };
                              const colors: Record<string, string> = { azure: 'blue', aws: 'orange', gcp: 'green' };
                              const c = colors[provider];
                              const isCheapest = multiCloudResult.cheapestProvider === provider;
                              return (
                                <div key={provider}
                                  className={`rounded-xl border-2 p-4 text-center ${isCheapest ? `border-${c}-400 bg-${c}-50 dark:bg-${c}-950/20` : 'border-muted'}`}>
                                  {isCheapest && (
                                    <div className="flex justify-center mb-1">
                                      <Trophy className="w-4 h-4 text-amber-500" />
                                    </div>
                                  )}
                                  <p className="text-xs text-muted-foreground font-medium">{labels[provider]}</p>
                                  <p className="text-2xl font-bold mt-1">₹{multiCloudResult.totals[provider].toFixed(0)}</p>
                                  <p className="text-xs text-muted-foreground">/month</p>
                                  <p className="text-xs font-medium mt-1 text-muted-foreground">
                                    ₹{multiCloudResult.annualTotals[provider].toFixed(0)}/yr
                                  </p>
                                  {isCheapest && (
                                    <Badge className="mt-2 bg-emerald-600 text-white text-xs">Cheapest</Badge>
                                  )}
                                </div>
                              );
                            })}
                          </div>

                          {/* Comparison Table */}
                          {multiCloudResult.lineItems.length > 0 && (
                            <div className="overflow-x-auto rounded-lg border">
                              <table className="w-full text-sm">
                                <thead className="bg-muted/50">
                                  <tr>
                                    <th className="text-left p-3 font-medium">Resource</th>
                                    <th className="text-right p-3 font-medium text-blue-600">Azure</th>
                                    <th className="text-right p-3 font-medium text-orange-600">AWS</th>
                                    <th className="text-right p-3 font-medium text-green-600">GCP</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y">
                                  {multiCloudResult.lineItems.map((item: any, i: number) => (
                                    <tr key={i} className="hover:bg-muted/30">
                                      <td className="p-3">
                                        <p className="font-medium">{item.resourceName}</p>
                                        <p className="text-xs text-muted-foreground">{item.role}</p>
                                      </td>
                                      <td className="p-3 text-right">
                                        <p className="font-medium">₹{item.azureMonthly.toFixed(0)}</p>
                                        <p className="text-xs text-muted-foreground font-mono">{item.azureSku}</p>
                                      </td>
                                      <td className="p-3 text-right">
                                        <p className="font-medium">₹{item.awsMonthly.toFixed(0)}</p>
                                        <p className="text-xs text-muted-foreground">{item.awsEquivalent}</p>
                                      </td>
                                      <td className="p-3 text-right">
                                        <p className="font-medium">₹{item.gcpMonthly.toFixed(0)}</p>
                                        <p className="text-xs text-muted-foreground">{item.gcpEquivalent}</p>
                                      </td>
                                    </tr>
                                  ))}
                                  {/* Totals row */}
                                  <tr className="bg-muted/30 font-semibold">
                                    <td className="p-3">Total / month</td>
                                    <td className="p-3 text-right text-blue-700">₹{multiCloudResult.totals.azure.toFixed(0)}</td>
                                    <td className="p-3 text-right text-orange-700">₹{multiCloudResult.totals.aws.toFixed(0)}</td>
                                    <td className="p-3 text-right text-green-700">₹{multiCloudResult.totals.gcp.toFixed(0)}</td>
                                  </tr>
                                </tbody>
                              </table>
                            </div>
                          )}

                          {multiCloudResult.lineItems.length === 0 && (
                            <p className="text-sm text-muted-foreground py-4 text-center">
                              No comparable resources found. Supported: VMs, AKS, App Service, SQL, PostgreSQL, MySQL, Redis, Storage, and Container Registry.
                            </p>
                          )}

                          {/* Insights */}
                          <div className="rounded-xl border bg-muted/30 p-4 space-y-2">
                            <p className="text-sm font-semibold">Insights</p>
                            {multiCloudResult.insights.map((insight: string, i: number) => (
                              <p key={i} className="text-sm text-muted-foreground">• {insight}</p>
                            ))}
                          </div>

                          <Button variant="outline" size="sm" onClick={() => { setMultiCloudResult(null); multiCloudMutation.reset(); }}>
                            Re-compare
                          </Button>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </TabsContent>
              </Tabs>

              {/* Action Buttons */}
              <div className="flex justify-between">
                <Button variant="outline" onClick={() => setCurrentStep(1)}>Start New Analysis</Button>
                <Button variant="outline" onClick={() => setLocation("/")}>Return Home</Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
