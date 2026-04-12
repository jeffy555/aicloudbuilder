import { useState, Fragment } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { TrendingDown, CheckCircle2, AlertCircle, Info, ChevronDown, ChevronUp, BarChart3 } from "lucide-react";
import ResourceMetricsChart from "./ResourceMetricsChart";
import type { ValuationResource } from "@shared/schema";

interface Props {
  resources: ValuationResource[];
  currencySymbol?: string;
}

export default function ValuationResourceTable({ resources, currencySymbol = '₹' }: Props) {
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

  const toggleRow = (resourceId: string) => {
    const newExpanded = new Set(expandedRows);
    if (newExpanded.has(resourceId)) {
      newExpanded.delete(resourceId);
    } else {
      newExpanded.add(resourceId);
    }
    setExpandedRows(newExpanded);
  };

  if (resources.length === 0) {
    return (
      <Card className="border-2 border-slate-200 dark:border-slate-800">
        <CardHeader>
          <CardTitle className="text-lg">Resource Analysis</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-center py-8">
            No resources found to analyze.
          </p>
        </CardContent>
      </Card>
    );
  }

  const resourcesWithMetrics = resources.filter(r => r.metricsAvailable).length;

  return (
    <Card className="border-2 border-slate-200 dark:border-slate-800 shadow-lg overflow-hidden">
      <CardHeader className="bg-gradient-to-r from-slate-50 to-white dark:from-slate-900/50 dark:to-background border-b px-6 py-4">
        <CardTitle className="text-lg flex items-center gap-2 flex-wrap">
          <div className="p-2 rounded-lg bg-slate-100 dark:bg-slate-800">
            <Info className="w-4 h-4 text-slate-600 dark:text-slate-400" />
          </div>
          <span>Resource Analysis</span>
          <div className="ml-auto flex gap-2 flex-wrap">
            {resourcesWithMetrics > 0 && (
              <Badge variant="outline" className="text-xs border-blue-300 bg-blue-50 text-blue-800 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-300">
                <BarChart3 className="w-3 h-3 mr-1" />
                {resourcesWithMetrics} with metrics
              </Badge>
            )}
            <Badge variant="outline" className="text-xs">
              {resources.length} {resources.length === 1 ? 'resource' : 'resources'}
            </Badge>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-slate-50 dark:bg-slate-900/50 hover:bg-slate-50 dark:hover:bg-slate-900/50 border-b-2">
                <TableHead className="font-semibold w-12 text-center"></TableHead>
                <TableHead className="font-semibold min-w-[200px]">Resource Name</TableHead>
                <TableHead className="font-semibold min-w-[150px]">Type</TableHead>
                <TableHead className="font-semibold min-w-[120px]">Current SKU</TableHead>
                <TableHead className="font-semibold min-w-[80px]">Tier</TableHead>
                <TableHead className="font-semibold min-w-[120px]">Monthly Cost</TableHead>
                <TableHead className="font-semibold min-w-[120px]">Yearly Cost</TableHead>
                <TableHead className="font-semibold min-w-[140px]">Optimization</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {resources.map((resource) => {
                const isExpanded = expandedRows.has(resource.id);
                const hasMetrics = resource.metricsAvailable && resource.usageMetrics;

                return (
                  <>
                    <TableRow
                      key={resource.id}
                      className="hover:bg-slate-50 dark:hover:bg-slate-900/30 transition-colors"
                    >
                      {/* Expand Button */}
                      <TableCell className="text-center">
                        {hasMetrics ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => toggleRow(resource.id)}
                            className="h-8 w-8 p-0 mx-auto"
                            title="Click to view metrics"
                          >
                            {isExpanded ? (
                              <ChevronUp className="w-4 h-4" />
                            ) : (
                              <ChevronDown className="w-4 h-4" />
                            )}
                          </Button>
                        ) : null}
                      </TableCell>

                      {/* Resource Name */}
                      <TableCell className="font-medium">
                        <div className="flex flex-col gap-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-medium">{resource.name}</span>
                            {hasMetrics && (
                              <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-300">
                                <BarChart3 className="w-3 h-3 mr-0.5" />
                                Metrics
                              </Badge>
                            )}
                          </div>
                          <span className="text-xs text-muted-foreground">{resource.location}</span>
                        </div>
                      </TableCell>

                      {/* Type */}
                      <TableCell>
                        <Badge variant="outline" className="text-xs font-normal">
                          {resource.type}
                        </Badge>
                      </TableCell>

                      {/* Current SKU */}
                      <TableCell>
                        <span className="text-sm font-medium">{resource.currentSku}</span>
                      </TableCell>

                      {/* Tier */}
                      <TableCell>
                        <span className="text-sm">{resource.currentTier || '-'}</span>
                      </TableCell>

                      {/* Monthly Cost */}
                      <TableCell>
                        {(resource as any).pricingError ? (
                          <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-300 dark:bg-amber-950/30 dark:text-amber-300 text-xs">
                            Price unavailable
                          </Badge>
                        ) : (
                          <span className="text-sm font-mono font-semibold text-blue-700 dark:text-blue-400">
                            {currencySymbol}{resource.monthlyCost.toFixed(2)}
                          </span>
                        )}
                      </TableCell>

                      {/* Yearly Cost */}
                      <TableCell>
                        {(resource as any).pricingError ? (
                          <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-300 dark:bg-amber-950/30 dark:text-amber-300 text-xs">
                            Price unavailable
                          </Badge>
                        ) : (
                          <span className="text-sm font-mono text-slate-600 dark:text-slate-400">
                            {currencySymbol}{resource.yearlyCost.toFixed(2)}
                          </span>
                        )}
                      </TableCell>

                      {/* Optimization */}
                      <TableCell>
                        {resource.remediation ? (
                          <Popover>
                            <PopoverTrigger>
                              <Badge className="bg-gradient-to-r from-emerald-100 to-green-100 text-emerald-800 dark:from-emerald-900/50 dark:to-green-900/50 dark:text-emerald-200 cursor-pointer hover:scale-105 hover:shadow-md transition-all duration-200 border-emerald-200 dark:border-emerald-800" title="Click for details">
                                <TrendingDown className="w-3 h-3 mr-1" />
                                Save {resource.remediation.savings_percent}%
                              </Badge>
                            </PopoverTrigger>
                            <PopoverContent className="w-96 border-2 border-emerald-200 dark:border-emerald-800 shadow-xl">
                              <div className="space-y-3">
                                <div className="bg-emerald-50 dark:bg-emerald-950/30 p-3 rounded-lg border border-emerald-100 dark:border-emerald-900">
                                  <p className="font-semibold text-sm text-emerald-900 dark:text-emerald-100 flex items-center gap-2">
                                    <TrendingDown className="w-4 h-4" />
                                    Recommended: {resource.remediation.recommended_sku}
                                  </p>
                                  {resource.remediation.recommended_tier && (
                                    <p className="text-xs text-emerald-700 dark:text-emerald-300 mt-1">
                                      Tier: {resource.remediation.recommended_tier}
                                    </p>
                                  )}
                                </div>

                                <div className="border-t border-emerald-100 dark:border-emerald-900 pt-3">
                                  <p className="text-sm text-slate-700 dark:text-slate-300 leading-relaxed">
                                    {resource.remediation.reason}
                                  </p>
                                </div>

                                <div className="bg-gradient-to-r from-emerald-50 to-green-50 dark:from-emerald-950/20 dark:to-green-950/20 p-3 rounded-lg space-y-2">
                                  <div className="flex justify-between items-center text-sm">
                                    <span className="text-slate-600 dark:text-slate-400">Monthly Savings:</span>
                                    <span className="font-bold text-emerald-700 dark:text-emerald-400 text-lg">
                                      {currencySymbol}{resource.remediation.savings_monthly.toFixed(2)}
                                    </span>
                                  </div>
                                  <div className="flex justify-between items-center text-sm">
                                    <span className="text-slate-600 dark:text-slate-400">Confidence:</span>
                                    <Badge
                                      variant="outline"
                                      className={
                                        resource.remediation.confidence === 'high'
                                          ? 'border-green-300 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-950/30 dark:text-green-300'
                                          : resource.remediation.confidence === 'medium'
                                          ? 'border-yellow-300 bg-yellow-50 text-yellow-800 dark:border-yellow-800 dark:bg-yellow-950/30 dark:text-yellow-300'
                                          : 'border-orange-300 bg-orange-50 text-orange-800 dark:border-orange-800 dark:bg-orange-950/30 dark:text-orange-300'
                                      }
                                    >
                                      {resource.remediation.confidence}
                                    </Badge>
                                  </div>
                                </div>

                                <div className="border-t border-emerald-100 dark:border-emerald-900 pt-3">
                                  <p className="text-xs text-slate-600 dark:text-slate-400 flex items-start gap-2">
                                    <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                                    <span>
                                      <strong className="text-slate-900 dark:text-slate-100">Action Required:</strong>{' '}
                                      {resource.remediation.action_required}
                                    </span>
                                  </p>
                                </div>
                              </div>
                            </PopoverContent>
                          </Popover>
                        ) : (
                          <Badge className="bg-gradient-to-r from-blue-50 to-cyan-50 text-blue-800 dark:from-blue-950/30 dark:to-cyan-950/30 dark:text-blue-300 border-blue-200 dark:border-blue-800">
                            <CheckCircle2 className="w-3 h-3 mr-1" />
                            Optimized
                          </Badge>
                        )}
                      </TableCell>
                    </TableRow>

                    {/* Expandable Metrics Row */}
                    {isExpanded && hasMetrics && resource.usageMetrics && (
                      <TableRow key={`${resource.id}-metrics`} className="bg-slate-50/50 dark:bg-slate-900/20">
                        <TableCell colSpan={8} className="p-4">
                          <ResourceMetricsChart
                            metrics={resource.usageMetrics}
                            resourceName={resource.name}
                          />
                        </TableCell>
                      </TableRow>
                    )}
                  </>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
