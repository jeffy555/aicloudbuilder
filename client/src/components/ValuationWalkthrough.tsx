import { useState, useEffect, useCallback, useRef } from "react";
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Maximize2,
  Volume2,
  DollarSign,
  Cloud,
  Loader2,
  Check,
  Home,
  RefreshCw,
  Wallet,
  TrendingDown,
  Package,
  Lightbulb,
  Info,
  ArrowRight,
  CheckCircle2,
} from "lucide-react";

interface Slide {
  step: number;
  title: string;
  subtitle: string;
  icon: React.ElementType;
  content: React.ReactNode;
}

/* ─────────── Step Indicator (matches real Valuation 4-step flow) ─────────── */
const valuationSteps = [
  { number: 1, title: "Connect" },
  { number: 2, title: "Scan" },
  { number: 3, title: "Analyze" },
  { number: 4, title: "Results" },
];

function MiniStepIndicator({ currentStep }: { currentStep: number }) {
  return (
    <div className="flex items-center justify-center gap-0 mb-3">
      {valuationSteps.map((step, i) => (
        <div key={step.number} className="flex items-center">
          <div className="flex flex-col items-center">
            <div
              className={`w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-bold ${
                step.number < currentStep
                  ? "bg-gradient-to-r from-emerald-600 to-blue-500 text-white"
                  : step.number === currentStep
                  ? "bg-gradient-to-r from-emerald-600 to-blue-500 text-white ring-2 ring-emerald-300 scale-110"
                  : "bg-slate-200 text-slate-500"
              }`}
            >
              {step.number < currentStep ? <Check className="w-3 h-3" /> : step.number}
            </div>
            <span className="text-[7px] text-slate-400 mt-0.5 w-12 text-center truncate">{step.title}</span>
          </div>
          {i < valuationSteps.length - 1 && (
            <div className={`w-6 h-px mt-[-10px] ${step.number < currentStep ? "bg-gradient-to-r from-emerald-500 to-blue-500" : "bg-slate-200"}`} />
          )}
        </div>
      ))}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   VALUATION FLOW:
   Slide 1 — Welcome: Module overview
   Slide 2 — Step 1 — Connect: Azure credential verification
   Slide 3 — Step 2 — Scan: Resource discovery with progress
   Slide 4 — Step 3 — Analyze: Cost calculation with AI
   Slide 5 — Step 4 — Results: Summary cards
   Slide 6 — Step 4 — Results: Resource table with remediation
   ══════════════════════════════════════════════════════════════════════ */

/* ─────────── Slide 1: Welcome ─────────── */
function SlideWelcome() {
  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between px-2">
        <div className="flex items-center gap-2">
          <DollarSign className="w-4 h-4 text-emerald-600" />
          <span className="text-xs font-bold text-slate-900">Valuation Workflow</span>
        </div>
        <div className="flex gap-1.5">
          <div className="flex items-center gap-1 px-2 py-1 rounded border border-slate-200 bg-white text-[9px] text-slate-600">
            <RefreshCw className="w-3 h-3" /> Refresh
          </div>
          <div className="flex items-center gap-1 px-2 py-1 rounded border border-slate-200 bg-white text-[9px] text-slate-600">
            <Home className="w-3 h-3" /> Home
          </div>
        </div>
      </div>

      {/* Welcome card */}
      <div className="rounded-2xl border-2 border-emerald-200 bg-gradient-to-br from-emerald-50 to-white p-6 shadow-lg">
        <div className="flex flex-col items-center text-center space-y-3">
          <div className="w-16 h-16 rounded-full bg-gradient-to-br from-emerald-500 to-blue-500 flex items-center justify-center">
            <DollarSign className="w-8 h-8 text-white" />
          </div>
          <h3 className="text-lg font-bold text-slate-900">Welcome to Valuation Module</h3>
          <p className="text-[10px] text-slate-600 max-w-md">
            Analyze your live Azure cloud resources and identify cost optimization opportunities.
            Get actionable recommendations to reduce cloud spending.
          </p>
        </div>
      </div>

      {/* Features */}
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-xl border border-emerald-200 bg-white p-2">
          <Cloud className="w-4 h-4 text-emerald-600 mb-1" />
          <p className="text-[9px] font-semibold text-slate-900">Resource Discovery</p>
          <p className="text-[7px] text-slate-500">Scan all Azure resources</p>
        </div>
        <div className="rounded-xl border border-blue-200 bg-white p-2">
          <Wallet className="w-4 h-4 text-blue-600 mb-1" />
          <p className="text-[9px] font-semibold text-slate-900">Cost Analysis</p>
          <p className="text-[7px] text-slate-500">Real-time pricing lookup</p>
        </div>
        <div className="rounded-xl border border-purple-200 bg-white p-2">
          <TrendingDown className="w-4 h-4 text-purple-600 mb-1" />
          <p className="text-[9px] font-semibold text-slate-900">Savings Recommendations</p>
          <p className="text-[7px] text-slate-500">AI-powered SKU suggestions</p>
        </div>
        <div className="rounded-xl border border-amber-200 bg-white p-2">
          <Lightbulb className="w-4 h-4 text-amber-600 mb-1" />
          <p className="text-[9px] font-semibold text-slate-900">Export Reports</p>
          <p className="text-[7px] text-slate-500">Download cost analysis</p>
        </div>
      </div>
    </div>
  );
}

/* ─────────── Slide 2: Step 1 — Connect to Azure ─────────── */
function SlideConnect() {
  return (
    <div className="space-y-2.5">
      <MiniStepIndicator currentStep={1} />

      <div className="mb-2">
        <p className="text-xs font-bold text-slate-900">Connect to Azure</p>
        <p className="text-[9px] text-slate-500">Verify your Azure credentials and test connection</p>
      </div>

      {/* Connection card */}
      <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-lg">
        <div className="space-y-2">
          <div>
            <label className="text-[9px] font-semibold text-slate-900 mb-0.5 block">Subscription ID</label>
            <div className="h-6 bg-slate-50 rounded border border-slate-200 px-2 flex items-center">
              <p className="text-[8px] text-slate-600 font-mono">a1b2c3d4-e5f6-7890-abcd-ef1234567890</p>
            </div>
          </div>
          <div>
            <label className="text-[9px] font-semibold text-slate-900 mb-0.5 block">Tenant ID</label>
            <div className="h-6 bg-slate-50 rounded border border-slate-200 px-2 flex items-center">
              <p className="text-[8px] text-slate-600 font-mono">f0e9d8c7-b6a5-4321-9876-543210fedcba</p>
            </div>
          </div>
          <div>
            <label className="text-[9px] font-semibold text-slate-900 mb-0.5 block">Client ID</label>
            <div className="h-6 bg-slate-50 rounded border border-slate-200 px-2 flex items-center">
              <p className="text-[8px] text-slate-600 font-mono">12345678-90ab-cdef-1234-567890abcdef</p>
            </div>
          </div>
          <div>
            <label className="text-[9px] font-semibold text-slate-900 mb-0.5 block">Client Secret</label>
            <div className="h-6 bg-slate-50 rounded border border-slate-200 px-2 flex items-center">
              <p className="text-[8px] text-slate-400">••••••••••••••••••••••••••••</p>
            </div>
          </div>
        </div>

        <div className="mt-2 flex items-start gap-2 p-2 rounded-lg bg-blue-50 border border-blue-200">
          <Info className="w-3 h-3 text-blue-600 shrink-0 mt-0.5" />
          <p className="text-[7px] text-blue-700 leading-relaxed">
            Credentials are stored securely via Bitwarden Secret Manager or environment variables
          </p>
        </div>

        <button className="mt-3 w-full px-3 py-1.5 rounded-md bg-primary text-white text-[9px] font-medium flex items-center justify-center gap-1.5 hover:bg-primary/90 transition-colors">
          <Cloud className="w-3 h-3" />
          Test Connection
        </button>
      </div>

      {/* Success banner */}
      <div className="rounded-xl border-2 border-green-300 bg-green-50 p-2.5 flex items-center gap-2">
        <div className="w-6 h-6 rounded-full bg-green-100 flex items-center justify-center shrink-0">
          <Check className="w-4 h-4 text-green-600" />
        </div>
        <div>
          <p className="text-[9px] font-semibold text-green-800">Connection Successful!</p>
          <p className="text-[7px] text-green-700">Azure subscription verified · Ready to scan resources</p>
        </div>
      </div>
    </div>
  );
}

/* ─────────── Slide 3: Step 2 — Scan Resources ─────────── */
function SlideScan() {
  return (
    <div className="space-y-2.5">
      <MiniStepIndicator currentStep={2} />

      <div className="text-center">
        <p className="text-xs font-bold text-slate-900">Scan Resources</p>
        <p className="text-[9px] text-slate-500">Fetch all deployed resources from your Azure subscription</p>
      </div>

      {/* Scanning process */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 text-center shadow-lg">
        <div className="flex flex-col items-center gap-2.5">
          <Loader2 className="w-7 h-7 animate-spin text-primary" />
          <p className="text-xs font-semibold text-slate-900">Scanning Azure Resources...</p>
          <p className="text-[9px] text-slate-500 max-w-xs leading-relaxed">
            Discovering Storage Accounts, Virtual Machines, SQL Databases, App Services, and more
          </p>
          <div className="mt-1 w-full max-w-[200px] h-1.5 bg-slate-100 rounded-full overflow-hidden">
            <div className="h-full bg-gradient-to-r from-blue-500 to-emerald-500 rounded-full animate-pulse" style={{ width: "65%" }} />
          </div>
          <p className="text-[7px] text-slate-400">Scanning in progress...</p>
        </div>
      </div>

      {/* Resource discovery grid */}
      <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-lg">
        <div className="flex items-center justify-between mb-2">
          <p className="text-[9px] font-semibold text-slate-900">Resources Discovered</p>
          <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-gradient-to-r from-blue-50 to-emerald-50 border border-emerald-200">
            <Check className="w-2.5 h-2.5 text-emerald-600" />
            <span className="text-[8px] text-emerald-700 font-bold">15 found</span>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          {[
            { type: "Storage Accounts", count: 5, color: "blue", icon: Package },
            { type: "Virtual Machines", count: 3, color: "purple", icon: Cloud },
            { type: "SQL Databases", count: 4, color: "amber", icon: Wallet },
            { type: "App Services", count: 3, color: "emerald", icon: TrendingDown },
          ].map((resource) => {
            const Icon = resource.icon;
            return (
              <div key={resource.type} className="flex items-center justify-between p-1.5 rounded-lg border border-slate-200 bg-gradient-to-br from-slate-50 to-white">
                <div className="flex items-center gap-1.5">
                  <div className={`p-1 rounded bg-${resource.color}-100`}>
                    <Icon className={`w-2.5 h-2.5 text-${resource.color}-600`} />
                  </div>
                  <p className="text-[8px] font-medium text-slate-900">{resource.type}</p>
                </div>
                <span className="text-[9px] font-bold text-slate-700">{resource.count}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ─────────── Slide 4: Step 3 — Analyze Costs ─────────── */
function SlideAnalyze() {
  return (
    <div className="space-y-2.5">
      <MiniStepIndicator currentStep={3} />

      <div className="text-center">
        <p className="text-xs font-bold text-slate-900">Analyze Costs</p>
        <p className="text-[9px] text-slate-500">Calculate costs and generate optimization recommendations</p>
      </div>

      {/* Analysis process card */}
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-lg">
        <div className="flex flex-col items-center gap-2">
          <div className="w-10 h-10 rounded-full bg-gradient-to-br from-emerald-500 to-blue-500 flex items-center justify-center">
            <Wallet className="w-5 h-5 text-white animate-pulse" />
          </div>
          <p className="text-xs font-semibold text-slate-900">Analyzing Costs...</p>
          <p className="text-[8px] text-slate-500 text-center max-w-xs leading-relaxed">
            Processing 15 resources · Calculating costs · Generating recommendations
          </p>
        </div>

        <div className="mt-3 space-y-1.5">
          <div className="flex items-center gap-2 p-1.5 rounded bg-green-50">
            <div className="w-4 h-4 rounded-full bg-green-100 flex items-center justify-center shrink-0">
              <Check className="w-2.5 h-2.5 text-green-600" />
            </div>
            <p className="text-[8px] text-slate-700">Fetching Azure Retail Pricing API</p>
          </div>
          <div className="flex items-center gap-2 p-1.5 rounded bg-green-50">
            <div className="w-4 h-4 rounded-full bg-green-100 flex items-center justify-center shrink-0">
              <Check className="w-2.5 h-2.5 text-green-600" />
            </div>
            <p className="text-[8px] text-slate-700">Mapping ARM resource types to Terraform</p>
          </div>
          <div className="flex items-center gap-2 p-1.5 rounded bg-blue-50">
            <Loader2 className="w-3 h-3 animate-spin text-primary shrink-0 ml-0.5" />
            <p className="text-[8px] text-slate-700 font-medium">Generating SKU downgrade recommendations</p>
          </div>
          <div className="flex items-center gap-2 p-1.5 rounded bg-slate-50">
            <div className="w-4 h-4 rounded-full bg-slate-200 flex items-center justify-center shrink-0">
              <span className="text-[7px] text-slate-500">4</span>
            </div>
            <p className="text-[8px] text-slate-500">Calculating potential savings</p>
          </div>
        </div>
      </div>

      {/* Insight banner */}
      <div className="border border-dashed border-purple-300 bg-gradient-to-r from-purple-50 to-blue-50 rounded-lg p-2 text-[9px] text-purple-700">
        <div className="flex items-start gap-2">
          <Lightbulb className="w-3 h-3 text-purple-600 shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold">Rule-Based Optimization Engine</p>
            <p className="text-[7px] text-purple-600 mt-0.5">
              Analyzes SKU tier vs resource size to identify over-provisioning (e.g., Premium Storage for small workloads)
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─────────── Slide 5: Step 4 — Results Summary Cards ─────────── */
function SlideResultsSummary() {
  return (
    <div className="space-y-2.5">
      <MiniStepIndicator currentStep={4} />

      <div className="text-center mb-1">
        <p className="text-xs font-bold text-slate-900">Analysis Complete</p>
        <p className="text-[9px] text-slate-500">Cost breakdown and optimization recommendations</p>
      </div>

      {/* Summary metrics grid */}
      <div className="grid grid-cols-2 gap-2">
        {/* Total Monthly Cost */}
        <div className="relative overflow-hidden border-2 border-blue-200 bg-gradient-to-br from-blue-50 via-white to-blue-50/30 rounded-xl p-2.5 shadow-md">
          <div className="absolute top-0 right-0 w-16 h-16 bg-blue-500/5 rounded-full -mr-8 -mt-8" />
          <div className="relative">
            <div className="flex items-center gap-1.5 mb-1.5">
              <div className="p-1.5 rounded-lg bg-blue-500/20 shadow-sm">
                <Wallet className="w-3 h-3 text-blue-600" />
              </div>
              <p className="text-[8px] font-semibold text-blue-700 uppercase tracking-wide">Total Monthly</p>
            </div>
            <p className="text-xl font-bold text-blue-900 tracking-tight">₹12,450</p>
            <p className="text-[7px] text-blue-600 mt-0.5">₹149,400/year</p>
          </div>
        </div>

        {/* Potential Savings */}
        <div className="relative overflow-hidden border-2 border-emerald-200 bg-gradient-to-br from-emerald-50 via-white to-emerald-50/30 rounded-xl p-2.5 shadow-md">
          <div className="absolute top-0 right-0 w-16 h-16 bg-emerald-500/5 rounded-full -mr-8 -mt-8" />
          <div className="relative">
            <div className="flex items-center gap-1.5 mb-1.5">
              <div className="p-1.5 rounded-lg bg-emerald-500/20 shadow-sm">
                <TrendingDown className="w-3 h-3 text-emerald-600" />
              </div>
              <p className="text-[8px] font-semibold text-emerald-700 uppercase tracking-wide">Savings</p>
            </div>
            <p className="text-xl font-bold text-emerald-900 tracking-tight">₹4,860</p>
            <div className="mt-1 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-gradient-to-r from-emerald-100 to-green-100 border border-emerald-200">
              <span className="text-[8px] font-bold text-emerald-700">39% reduction</span>
            </div>
          </div>
        </div>

        {/* Resources Scanned */}
        <div className="relative overflow-hidden border-2 border-purple-200 bg-gradient-to-br from-purple-50 via-white to-purple-50/30 rounded-xl p-2.5 shadow-md">
          <div className="absolute top-0 right-0 w-16 h-16 bg-purple-500/5 rounded-full -mr-8 -mt-8" />
          <div className="relative">
            <div className="flex items-center gap-1.5 mb-1.5">
              <div className="p-1.5 rounded-lg bg-purple-500/20 shadow-sm">
                <Package className="w-3 h-3 text-purple-600" />
              </div>
              <p className="text-[8px] font-semibold text-purple-700 uppercase tracking-wide">Resources</p>
            </div>
            <p className="text-xl font-bold text-purple-900 tracking-tight">15</p>
            <p className="text-[7px] text-purple-600 mt-0.5">Across 4 types</p>
          </div>
        </div>

        {/* Recommendations */}
        <div className="relative overflow-hidden border-2 border-amber-200 bg-gradient-to-br from-amber-50 via-white to-amber-50/30 rounded-xl p-2.5 shadow-md">
          <div className="absolute top-0 right-0 w-16 h-16 bg-amber-500/5 rounded-full -mr-8 -mt-8" />
          <div className="relative">
            <div className="flex items-center gap-1.5 mb-1.5">
              <div className="p-1.5 rounded-lg bg-amber-500/20 shadow-sm">
                <Lightbulb className="w-3 h-3 text-amber-600" />
              </div>
              <p className="text-[8px] font-semibold text-amber-700 uppercase tracking-wide">Recommendations</p>
            </div>
            <p className="text-xl font-bold text-amber-900 tracking-tight">8</p>
            <p className="text-[7px] text-amber-600 mt-0.5">Actionable items</p>
          </div>
        </div>
      </div>

      {/* Success banner */}
      <div className="rounded-xl border-2 border-green-300 bg-gradient-to-r from-green-50 to-emerald-50 p-2 flex items-center gap-2 shadow-sm">
        <div className="w-6 h-6 rounded-full bg-green-100 flex items-center justify-center shrink-0">
          <Check className="w-4 h-4 text-green-600" />
        </div>
        <div>
          <p className="text-[9px] font-semibold text-green-800">Cost Analysis Complete</p>
          <p className="text-[7px] text-green-700">Found 8 optimization opportunities · Up to 39% monthly savings possible</p>
        </div>
      </div>
    </div>
  );
}

/* ─────────── Slide 6: Step 4 — Resource Table with Remediation ─────────── */
function SlideResourceTable() {
  return (
    <div className="space-y-2.5">
      <MiniStepIndicator currentStep={4} />

      <div className="text-center mb-1">
        <p className="text-xs font-bold text-slate-900">Resource Analysis Table</p>
        <p className="text-[9px] text-slate-500">Detailed cost breakdown with remediation plans</p>
      </div>

      {/* Enhanced table */}
      <div className="rounded-2xl border-2 border-slate-200 bg-white overflow-hidden shadow-lg">
        <div className="px-3 py-2 bg-gradient-to-r from-slate-50 to-white border-b flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Info className="w-3 h-3 text-slate-600" />
            <p className="text-[9px] font-semibold text-slate-900">Resource Inventory</p>
          </div>
          <span className="text-[7px] text-slate-500">15 resources analyzed</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[8px]">
            <thead className="bg-slate-50/50 border-b border-slate-200">
              <tr>
                <th className="px-2 py-1.5 text-left font-semibold text-slate-700 uppercase tracking-wide text-[7px]">Resource Name</th>
                <th className="px-2 py-1.5 text-left font-semibold text-slate-700 uppercase tracking-wide text-[7px]">Type</th>
                <th className="px-2 py-1.5 text-left font-semibold text-slate-700 uppercase tracking-wide text-[7px]">SKU</th>
                <th className="px-2 py-1.5 text-right font-semibold text-slate-700 uppercase tracking-wide text-[7px]">Monthly</th>
                <th className="px-2 py-1.5 text-center font-semibold text-slate-700 uppercase tracking-wide text-[7px]">Action</th>
              </tr>
            </thead>
            <tbody>
              {[
                { name: "storage-prod", type: "Storage Account", sku: "Premium_LRS", cost: "₹2,340", savings: "60%", savingsAmount: "₹1,404" },
                { name: "sql-database-1", type: "SQL Database", sku: "P2 (Premium)", cost: "₹4,890", savings: "45%", savingsAmount: "₹2,201" },
                { name: "storage-backup", type: "Storage Account", sku: "Premium_GRS", cost: "₹3,120", savings: "60%", savingsAmount: "₹1,872" },
              ].map((resource, idx) => (
                <tr key={idx} className="border-b border-slate-100 hover:bg-blue-50/30 transition-colors">
                  <td className="px-2 py-2">
                    <p className="font-semibold text-slate-900">{resource.name}</p>
                  </td>
                  <td className="px-2 py-2 text-slate-600">{resource.type}</td>
                  <td className="px-2 py-2">
                    <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 font-mono text-[7px]">
                      {resource.sku}
                    </span>
                  </td>
                  <td className="px-2 py-2 text-right font-semibold text-slate-900">{resource.cost}</td>
                  <td className="px-2 py-2 text-center">
                    <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gradient-to-r from-green-100 to-emerald-100 border border-emerald-300 shadow-sm">
                      <TrendingDown className="w-2.5 h-2.5 text-emerald-700" />
                      <span className="text-[8px] font-bold text-emerald-800">-{resource.savings}</span>
                    </div>
                  </td>
                </tr>
              ))}
              <tr className="hover:bg-slate-50/30 transition-colors">
                <td className="px-2 py-2">
                  <p className="font-semibold text-slate-900">app-service-1</p>
                </td>
                <td className="px-2 py-2 text-slate-600">App Service</td>
                <td className="px-2 py-2">
                  <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 font-mono text-[7px]">
                    S1 (Standard)
                  </span>
                </td>
                <td className="px-2 py-2 text-right font-semibold text-slate-900">₹1,200</td>
                <td className="px-2 py-2 text-center">
                  <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-100 border border-slate-200">
                    <Check className="w-2 h-2 text-slate-500" />
                    <span className="text-[7px] text-slate-600 font-medium">Optimized</span>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Remediation detail callout */}
      <div className="rounded-xl border-2 border-emerald-300 bg-gradient-to-br from-emerald-50 via-white to-emerald-50/30 p-2.5 shadow-md">
        <div className="flex items-start gap-2">
          <div className="p-1.5 rounded-lg bg-emerald-500/20 shrink-0 shadow-sm">
            <Lightbulb className="w-3.5 h-3.5 text-emerald-600" />
          </div>
          <div className="flex-1">
            <div className="flex items-center justify-between mb-1">
              <p className="text-[9px] font-bold text-emerald-900">Recommendation: storage-prod</p>
              <span className="px-1.5 py-0.5 rounded-full bg-emerald-100 text-[7px] font-bold text-emerald-700">Medium Confidence</span>
            </div>
            <div className="p-1.5 rounded-lg bg-white/60 border border-emerald-200 mb-1.5">
              <p className="text-[8px] text-slate-700">
                Downgrade from <span className="font-bold text-slate-900">Premium_LRS</span> → <span className="font-bold text-emerald-700">Standard_LRS</span>
              </p>
            </div>
            <div className="flex items-center gap-2 mb-1">
              <div className="flex items-center gap-1">
                <TrendingDown className="w-2.5 h-2.5 text-emerald-600" />
                <span className="text-[8px] font-semibold text-emerald-700">₹1,404/month saved</span>
              </div>
              <div className="w-px h-3 bg-slate-300" />
              <span className="text-[8px] text-slate-600">60% reduction</span>
            </div>
            <p className="text-[7px] text-slate-600 leading-relaxed italic">
              Premium Storage tier over-provisioned for typical workloads. Standard tier provides sufficient performance for most use cases while reducing costs significantly.
            </p>
            <div className="mt-1.5 pt-1.5 border-t border-emerald-200">
              <p className="text-[7px] text-slate-500">
                <span className="font-semibold">Action Required:</span> Change SKU from Premium to Standard in Azure Portal
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const slides: Slide[] = [
  { step: 1, title: "Azure Cost Visibility in Minutes", subtitle: "Connect once — see your entire Azure spend broken down by resource, SKU, and service tier", icon: DollarSign, content: <SlideWelcome /> },
  { step: 2, title: "Secure Azure Connection", subtitle: "Uses your existing credentials — read-only access, nothing stored, no new service principals needed", icon: Cloud, content: <SlideConnect /> },
  { step: 3, title: "Full Resource Inventory", subtitle: "Every VM, Storage, App Service, Redis, SQL, AKS node scanned — nothing missed, nothing estimated", icon: Package, content: <SlideScan /> },
  { step: 4, title: "Live Pricing, Not Estimates", subtitle: "Azure Retail API + Cost Management queried in real time — actual spend, not catalog guesses", icon: Wallet, content: <SlideAnalyze /> },
  { step: 5, title: "Cost Breakdown & Savings Map", subtitle: "Total spend, per-resource costs, and identified savings opportunities — all in one dashboard", icon: TrendingDown, content: <SlideResultsSummary /> },
  { step: 6, title: "Actionable SKU Rightsizing", subtitle: "Specific downgrades with %-saving estimates — not 'consider optimizing', but exactly which SKU to change to", icon: Lightbulb, content: <SlideResourceTable /> },
];

const SLIDE_DURATION = 5000;

function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function ValuationWalkthrough() {
  const [currentSlide, setCurrentSlide] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const progressRef = useRef<number>(0);
  const animFrameRef = useRef<number>(0);
  const lastTickRef = useRef<number>(0);

  const totalDuration = slides.length * SLIDE_DURATION;
  const elapsedSeconds = (progress / 100) * (totalDuration / 1000);
  const totalSeconds = totalDuration / 1000;

  const nextSlide = useCallback(() => {
    setCurrentSlide((prev) => {
      const next = (prev + 1) % slides.length;
      progressRef.current = (next / slides.length) * 100;
      setProgress(progressRef.current);
      return next;
    });
  }, []);

  const prevSlide = useCallback(() => {
    setCurrentSlide((prev) => {
      const next = (prev - 1 + slides.length) % slides.length;
      progressRef.current = (next / slides.length) * 100;
      setProgress(progressRef.current);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!isPlaying) {
      cancelAnimationFrame(animFrameRef.current);
      return;
    }
    lastTickRef.current = performance.now();
    const animate = (now: number) => {
      const delta = now - lastTickRef.current;
      lastTickRef.current = now;
      const increment = (delta / totalDuration) * 100;
      progressRef.current += increment;
      if (progressRef.current >= 100) {
        progressRef.current = 0;
        setCurrentSlide(0);
      } else {
        const newSlide = Math.min(slides.length - 1, Math.floor((progressRef.current / 100) * slides.length));
        setCurrentSlide((prev) => (newSlide !== prev ? newSlide : prev));
      }
      setProgress(progressRef.current);
      animFrameRef.current = requestAnimationFrame(animate);
    };
    animFrameRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animFrameRef.current);
  }, [isPlaying, totalDuration]);

  const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const pct = Math.max(0, Math.min(100, (x / rect.width) * 100));
    progressRef.current = pct;
    setProgress(pct);
    setCurrentSlide(Math.min(slides.length - 1, Math.floor((pct / 100) * slides.length)));
  };

  if (!slides || slides.length === 0) return null;
  const safeIndex = Math.min(currentSlide, slides.length - 1);
  const slide = slides[safeIndex];
  if (!slide) return null;
  const Icon = slide.icon;

  return (
    <div className="rounded-xl overflow-hidden shadow-2xl border border-slate-800 bg-slate-950">
      <div className="bg-slate-900 px-5 py-3 flex items-center gap-3 border-b border-slate-800">
        <div className="w-8 h-8 rounded-full bg-emerald-500/20 flex items-center justify-center">
          <Icon className="w-4 h-4 text-emerald-400" />
        </div>
        <div className="flex-1">
          <p className="text-xs font-semibold text-white">
            {slide.step} of {slides.length}: {slide.title}
          </p>
          <p className="text-[11px] text-slate-400">{slide.subtitle}</p>
        </div>
        <div className="flex gap-1">
          {slides.map((s, i) => (
            <button
              key={i}
              onClick={() => { setCurrentSlide(i); progressRef.current = (i / slides.length) * 100; setProgress(progressRef.current); }}
              className={`w-2 h-2 rounded-full transition-all ${i === currentSlide ? "bg-emerald-500 scale-125" : i < currentSlide ? "bg-emerald-500/40" : "bg-slate-600"}`}
              title={`${s.title}`}
            />
          ))}
        </div>
      </div>

      <div className="p-5 bg-gradient-to-b from-slate-100 to-slate-50 min-h-[380px] relative">
        {!isPlaying && (
          <button onClick={() => setIsPlaying(true)} className="absolute inset-0 z-10 flex items-center justify-center bg-black/5 hover:bg-black/10 transition-colors cursor-pointer">
            <div className="w-16 h-16 rounded-full bg-black/70 backdrop-blur-sm flex items-center justify-center shadow-xl hover:bg-black/80 transition-colors">
              <Play className="w-7 h-7 text-white ml-1" />
            </div>
          </button>
        )}
        {slide.content}
      </div>

      <div className="bg-gradient-to-t from-slate-950 to-slate-900 px-2 pt-0 pb-2">
        <div className="group h-5 flex items-center cursor-pointer px-2" onClick={handleProgressClick}>
          <div className="w-full h-1 group-hover:h-1.5 bg-slate-700 rounded-full relative transition-all">
            {slides.map((_, i) => { const pos = ((i + 1) / slides.length) * 100; if (i === slides.length - 1) return null; return <div key={i} className="absolute top-0 bottom-0 w-px bg-slate-600" style={{ left: `${pos}%` }} />; })}
            <div className="absolute top-0 left-0 h-full bg-red-600 rounded-full transition-none" style={{ width: `${progress}%` }} />
            <div className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-red-600 opacity-0 group-hover:opacity-100 transition-opacity shadow-md" style={{ left: `${progress}%`, marginLeft: "-6px" }} />
          </div>
        </div>
        <div className="flex items-center gap-1 px-1">
          <button onClick={() => setIsPlaying(!isPlaying)} className="p-1.5 text-white hover:text-white/80 transition-colors">
            {isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
          </button>
          <button onClick={() => { prevSlide(); setIsPlaying(false); }} className="p-1.5 text-white/70 hover:text-white transition-colors"><SkipBack className="w-4 h-4" /></button>
          <button onClick={() => { nextSlide(); setIsPlaying(false); }} className="p-1.5 text-white/70 hover:text-white transition-colors"><SkipForward className="w-4 h-4" /></button>
          <button className="p-1.5 text-white/70 hover:text-white transition-colors"><Volume2 className="w-4 h-4" /></button>
          <span className="text-[11px] text-slate-400 font-mono ml-1">{formatTime(elapsedSeconds)} / {formatTime(totalSeconds)}</span>
          <div className="flex-1" />
          <span className="text-[10px] text-slate-500 mr-2">Valuation Walkthrough</span>
          <button className="p-1.5 text-white/70 hover:text-white transition-colors"><Maximize2 className="w-4 h-4" /></button>
        </div>
      </div>
    </div>
  );
}
