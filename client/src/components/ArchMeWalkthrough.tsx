import { useState, useEffect, useCallback, useRef } from "react";
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Maximize2,
  Volume2,
  Network,
  Home,
  RefreshCw,
  Loader2,
  Check,
  CheckCircle2,
  GitBranch,
  Code,
  FileCode,
  Cloud,
  CodeIcon,
  Shield,
  DollarSign,
  Wrench,
} from "lucide-react";

interface Slide {
  step: number;
  title: string;
  subtitle: string;
  icon: React.ElementType;
  content: React.ReactNode;
}

/* ─────────── Activity Button Bar ─────────── */
function ActivityButtonBar({ active }: { active: "scan" | "cost" | "best" | "draw" }) {
  const activities = [
    { id: "scan", label: "Security Scan", icon: Shield },
    { id: "cost", label: "Cost Analysis", icon: DollarSign },
    { id: "best", label: "Best Approach", icon: Wrench },
    { id: "draw", label: "Draw", icon: Network },
  ];
  return (
    <div className="flex gap-1 p-1 rounded-lg bg-slate-100 border border-slate-200">
      {activities.map((a) => {
        const Icon = a.icon;
        return (
          <div
            key={a.id}
            className={`flex items-center gap-1 px-2 py-1 rounded text-[8px] font-medium transition-colors ${
              active === a.id ? "bg-white shadow-sm text-slate-900 border border-slate-200" : "text-slate-500"
            }`}
          >
            <Icon className="w-3 h-3" />
            {a.label}
          </div>
        );
      })}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   ARCHME REAL FLOW (no numbered steps — uses named workflow steps):
   1. 'diagram'     — Chat panel (describe requirements) + Diagram panel side by side
                      After diagram generates → "Approve Diagram & Continue" button
   2. 'repository'  — Provider selection (GitHub/Azure DevOps) → Repo list + Create form
                      Must be empty repo (validated) → auto-extracts components
   3. 'components'  — Intent preview (artifact layers checkboxes) shown above
                      Extracted components list with badges
                      "Generate Code for All Components" button
   4. 'code'        — CodeEditor + ActivityPanel + README + Commit message + Push button
                      (all in one step — no separate commit step)
   ══════════════════════════════════════════════════════════════════════ */

/* ─────────── Slide 1: Describe Architecture (Chat + Diagram) ─────────── */
function SlideDescribeArchitecture() {
  return (
    <div className="space-y-2.5">
      {/* Header — matches real ArchMe header */}
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-lg bg-primary/10">
            <Network className="w-4 h-4 text-primary" />
          </div>
          <div>
            <span className="text-xs font-bold text-slate-900">ArchMe</span>
            <p className="text-[8px] text-slate-500">Generate architecture diagrams and infrastructure code</p>
          </div>
        </div>
        <div className="flex gap-1.5">
          <div className="flex items-center gap-1 px-2 py-1 rounded border border-slate-200 bg-white text-[8px] text-slate-600">
            <RefreshCw className="w-3 h-3" /> Refresh
          </div>
          <div className="flex items-center gap-1 px-2 py-1 rounded border border-slate-200 bg-white text-[8px] text-slate-600">
            <Home className="w-3 h-3" /> Home
          </div>
        </div>
      </div>

      {/* Scope banner — matches real amber warning */}
      <div className="border border-amber-200 bg-amber-50 rounded p-2 text-[8px]">
        <p className="font-semibold text-amber-700">Architecture-only workflow</p>
        <p className="text-amber-600">ArchMe always creates a brand-new repository from scratch, and it only produces architecture diagrams and high-level explanations.</p>
      </div>

      {/* Two-column: Chat + Diagram — matches real grid layout */}
      <div className="grid grid-cols-2 gap-2">
        {/* Chat Panel */}
        <div className="border border-slate-200 rounded-lg bg-white overflow-hidden">
          <div className="border-b border-slate-200 px-2.5 py-1.5">
            <p className="text-[9px] font-semibold text-slate-900">Describe Your Architecture</p>
            <p className="text-[7px] text-slate-500">Enter your architecture requirements in natural language</p>
          </div>
          {/* Validation keywords bar */}
          <div className="border-b border-slate-200 bg-slate-50 px-2.5 py-1">
            <p className="text-[7px] text-slate-400">Detected architecture keywords</p>
            <p className="text-[7px] text-slate-700">kubernetes, container, monitoring, prometheus, grafana, storage</p>
          </div>
          <div className="p-2 space-y-1.5">
            {/* System message */}
            <div className="flex gap-1.5">
              <div className="w-4 h-4 rounded-full bg-primary flex items-center justify-center flex-shrink-0">
                <Network className="w-2.5 h-2.5 text-white" />
              </div>
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-1.5 text-[7px] text-slate-700 flex-1">
                Welcome to ArchMe! Describe your architecture requirements...
              </div>
            </div>
            {/* User message */}
            <div className="flex gap-1.5 justify-end">
              <div className="bg-primary/10 border border-primary/20 rounded-lg p-1.5 text-[7px] text-slate-700 max-w-[90%]">
                Deploy e-commerce microservices on AKS with ACR, Key Vault, Storage, and Prometheus/Grafana monitoring
              </div>
            </div>
            {/* AI analyzing */}
            <div className="flex gap-1.5">
              <div className="w-4 h-4 rounded-full bg-primary flex items-center justify-center flex-shrink-0">
                <Loader2 className="w-2.5 h-2.5 text-white animate-spin" />
              </div>
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-1.5 text-[7px] text-slate-500 flex-1">
                Analyzing your architecture requirements and generating diagram...
              </div>
            </div>
          </div>
          {/* Chat input */}
          <div className="border-t border-slate-200 px-2 py-1.5">
            <div className="h-5 bg-slate-100 rounded px-2 flex items-center text-[7px] text-slate-400">Describe your architecture requirements...</div>
          </div>
        </div>

        {/* Diagram Panel */}
        <div className="border border-slate-200 rounded-lg bg-white overflow-hidden">
          <div className="border-b border-slate-200 px-2.5 py-1.5">
            <p className="text-[9px] font-semibold text-slate-900">Architecture Diagram</p>
            <p className="text-[7px] text-slate-500">Visual representation of your architecture</p>
          </div>
          <div className="p-2 flex flex-col items-center justify-center min-h-[150px]">
            <div className="flex flex-col items-center gap-1.5 w-full">
              <div className="px-2.5 py-1 rounded-lg bg-blue-100 border-2 border-blue-400 text-[7px] font-semibold text-blue-800">
                AKS Cluster
              </div>
              <div className="w-px h-2.5 bg-slate-400" />
              <div className="flex gap-2 items-start">
                <div className="flex flex-col items-center gap-1">
                  <div className="px-1.5 py-0.5 rounded bg-emerald-100 border border-emerald-300 text-[6px] text-emerald-800">ACR</div>
                </div>
                <div className="flex flex-col items-center gap-1">
                  <div className="px-1.5 py-0.5 rounded bg-violet-100 border border-violet-300 text-[6px] text-violet-800">Key Vault</div>
                </div>
                <div className="flex flex-col items-center gap-1">
                  <div className="px-1.5 py-0.5 rounded bg-amber-100 border border-amber-300 text-[6px] text-amber-800">Storage</div>
                </div>
                <div className="flex flex-col items-center gap-1">
                  <div className="px-1.5 py-0.5 rounded bg-rose-100 border border-rose-300 text-[6px] text-rose-800">Prometheus</div>
                  <div className="w-px h-1.5 bg-slate-300" />
                  <div className="px-1.5 py-0.5 rounded bg-rose-50 border border-rose-200 text-[6px] text-rose-700">Grafana</div>
                </div>
              </div>
            </div>
          </div>
          {/* Approve button — appears after diagram generates */}
          <div className="px-2.5 pb-2">
            <div className="w-full py-1.5 rounded-md bg-primary text-white text-[9px] font-medium text-center flex items-center justify-center gap-1">
              <CheckCircle2 className="w-3 h-3" /> Approve Diagram & Continue
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─────────── Slide 2: Repository Selection ─────────── */
function SlideRepoSelection() {
  return (
    <div className="space-y-3">
      {/* Card wrapper — matches real Card component */}
      <div className="border border-slate-200 rounded-lg bg-white overflow-hidden">
        <div className="border-b border-slate-200 px-4 py-3">
          <p className="text-xs font-semibold text-slate-900">Select Repository</p>
          <p className="text-[9px] text-slate-500">Choose where to push the generated infrastructure code</p>
        </div>
        <div className="p-3 space-y-3">
          {/* Provider cards — matches real green/blue cards */}
          <div className="grid grid-cols-2 gap-3 max-w-xs mx-auto">
            <div className="border border-green-200 bg-green-50 rounded-lg p-3 text-center cursor-pointer hover:shadow-lg transition-all">
              <div className="w-6 h-6 rounded-lg bg-green-100 flex items-center justify-center mx-auto mb-1">
                <CodeIcon className="w-3 h-3 text-green-600" />
              </div>
              <p className="text-[10px] font-semibold text-green-900">GitHub</p>
              <p className="text-[8px] text-green-700">Push to GitHub repository</p>
            </div>
            <div className="border border-blue-200 bg-blue-50 rounded-lg p-3 text-center cursor-pointer hover:shadow-lg transition-all">
              <div className="w-6 h-6 rounded-lg bg-blue-100 flex items-center justify-center mx-auto mb-1">
                <Cloud className="w-3 h-3 text-blue-600" />
              </div>
              <p className="text-[10px] font-semibold text-blue-900">Azure DevOps</p>
              <p className="text-[8px] text-blue-700">Push to Azure DevOps</p>
            </div>
          </div>

          {/* Repository list + Create form — matches real grid layout */}
          <div className="grid grid-cols-2 gap-3">
            <div className="border border-slate-200 rounded-lg bg-white p-2">
              {["ecommerce-infra", "aks-platform", "new-arch-repo"].map((repo, i) => (
                <div
                  key={repo}
                  className={`flex items-center gap-2 px-2 py-1.5 rounded text-[9px] ${
                    i === 2 ? "bg-primary/10 border border-primary/30 font-semibold text-primary" : "text-slate-600"
                  }`}
                >
                  <GitBranch className="w-3 h-3" />
                  {repo}
                </div>
              ))}
            </div>
            <div className="border border-slate-200 rounded-lg bg-white p-2">
              <p className="text-[9px] font-semibold text-slate-900 mb-1.5">Create New Repository</p>
              <div className="space-y-1.5">
                <div className="h-5 bg-slate-100 rounded px-2 flex items-center text-[7px] text-slate-400">Repository name</div>
                <div className="h-7 bg-slate-100 rounded px-2 flex items-start pt-1 text-[7px] text-slate-400">Description</div>
                <div className="px-2 py-1 rounded bg-primary text-white text-[7px] font-medium text-center">Create Repository</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Repo verification — matches real dashed border card */}
      <div className="border border-dashed border-primary/40 bg-primary/5 rounded-lg p-2.5">
        <p className="text-[8px] uppercase tracking-[0.3em] text-slate-500 font-semibold">Repository verification</p>
        <p className="text-[8px] text-slate-500 mt-0.5">ArchMe only allows new or empty repositories. This repo passed the emptiness check.</p>
        <p className="text-[9px] font-semibold text-slate-900 mt-1">Empty repository</p>
        <p className="text-[8px] text-slate-500">File count: 0</p>
      </div>
    </div>
  );
}

/* ─────────── Slide 3: Components + Intent Preview ─────────── */
function SlideComponentsWithIntent() {
  return (
    <div className="space-y-2.5">
      {/* Intent preview — appears within components step */}
      <div className="border border-blue-200 bg-blue-50/40 rounded-lg p-2.5 space-y-1.5">
        <p className="text-[9px] font-semibold text-slate-900">Intent preview</p>
        <p className="text-[8px] text-slate-500">Confirm what layers of code ArchMe will produce before generating component-level artifacts.</p>
        <p className="text-[8px] text-slate-600">
          Your request: <span className="font-medium text-slate-900">Deploy e-commerce microservices on AKS...</span>
        </p>
        <p className="text-[8px] font-semibold text-slate-900">This request will generate:</p>
        <div className="space-y-1">
          {[
            { title: "Terraform infrastructure provisioning", detected: true, checked: true },
            { title: "Kubernetes/YAML manifests for workloads", detected: true, checked: true },
            { title: "Monitoring stack (Prometheus + Grafana)", detected: true, checked: true },
            { title: "Helm chart packaging", detected: false, checked: false },
            { title: "CI/CD pipeline manifests", detected: false, checked: false },
          ].map((layer) => (
            <div key={layer.title} className="flex gap-1.5 items-center">
              <input type="checkbox" checked={layer.checked} readOnly className="w-3 h-3 accent-primary" />
              <span className="text-[8px] font-medium text-slate-900">{layer.title}</span>
              <span className="text-[6px] text-slate-400">{layer.detected ? "(detected)" : "(optional)"}</span>
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          <div className="px-2 py-0.5 rounded border border-slate-200 bg-white text-[7px] text-slate-600">Edit Intent</div>
          <div className="px-2 py-0.5 rounded bg-primary text-white text-[7px] font-medium">Confirm & Continue</div>
        </div>
      </div>

      {/* Extracted Components — matches real Card layout */}
      <div className="border border-slate-200 rounded-lg bg-white overflow-hidden">
        <div className="border-b border-slate-200 px-3 py-2">
          <p className="text-[10px] font-semibold text-slate-900">Extracted Components</p>
          <p className="text-[8px] text-slate-500">6 components found in your architecture</p>
        </div>
        <div className="p-2 space-y-1">
          {[
            { name: "AKS Cluster", provider: "azure", category: "Compute", code: "terraform" },
            { name: "ACR Registry", provider: "azure", category: "Container", code: "terraform" },
            { name: "Key Vault", provider: "azure", category: "Security", code: "terraform" },
            { name: "Storage Account", provider: "azure", category: "Storage", code: "terraform" },
            { name: "Microservices", provider: "azure", category: "Workload", code: "kubernetes" },
            { name: "Monitoring Stack", provider: "third-party", category: "Observability", code: "kubernetes" },
          ].map((c) => (
            <div key={c.name} className="border border-slate-200 rounded p-1.5 flex items-center gap-1.5">
              <span className="text-[8px] font-semibold text-slate-900">{c.name}</span>
              <span className="px-1 py-0.5 rounded text-[6px] bg-slate-100 text-slate-500 border border-slate-200">{c.provider}</span>
              <span className="px-1 py-0.5 rounded text-[6px] bg-blue-50 text-blue-600 border border-blue-200">{c.category}</span>
              <span className="px-1 py-0.5 rounded text-[6px] bg-primary/10 text-primary border border-primary/20">{c.code}</span>
            </div>
          ))}
        </div>
        <div className="px-2 pb-2">
          <div className="w-full py-1.5 rounded-md bg-primary text-white text-[9px] font-medium text-center flex items-center justify-center gap-1">
            <Code className="w-3 h-3" /> Generate Code for All Components
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─────────── Slide 4: Code + Activities + Commit (all in one 'code' step) ─────────── */
function SlideCodeReviewCommit() {
  return (
    <div className="space-y-2">
      <div className="text-center">
        <p className="text-xs font-bold text-slate-900">Review & Activities</p>
        <p className="text-[9px] text-slate-500">Review generated code, run security scans, and analyze costs before committing</p>
      </div>

      {/* Code editor — matches real CodeEditor */}
      <div className="rounded-lg border border-slate-200 bg-slate-900 overflow-hidden">
        <div className="px-3 py-1.5 border-b border-slate-700 bg-slate-800/50 flex items-center gap-1.5">
          <FileCode className="w-3 h-3 text-slate-400" />
          <span className="text-[8px] text-slate-300 font-medium">Generated Code</span>
        </div>
        <div className="flex gap-0 border-b border-slate-700">
          <div className="px-2.5 py-1 bg-slate-800 text-[8px] text-white font-medium border-r border-slate-700">main.tf</div>
          <div className="px-2.5 py-1 text-[8px] text-slate-400">variables.tf</div>
          <div className="px-2.5 py-1 text-[8px] text-slate-400">aks.tf</div>
          <div className="px-2.5 py-1 text-[8px] text-slate-400">monitoring.yaml</div>
        </div>
        <div className="p-2 font-mono text-[7px] leading-relaxed text-green-400 h-[60px] overflow-hidden">
          <p><span className="text-violet-400">resource</span> <span className="text-amber-300">"azurerm_resource_group"</span> <span className="text-amber-300">"main"</span> {'{'}</p>
          <p>  name     = <span className="text-amber-300">"rg-ecommerce-prod"</span></p>
          <p>  location = <span className="text-amber-300">"eastus"</span></p>
          <p>{'}'}</p>
        </div>
      </div>

      {/* Activity Panel — below code editor */}
      <ActivityButtonBar active="scan" />

      {/* Scan summary */}
      <div className="flex items-center gap-2 p-2 rounded-lg bg-white border border-slate-200">
        <div className="relative w-8 h-8">
          <svg className="w-8 h-8 -rotate-90" viewBox="0 0 36 36">
            <circle cx="18" cy="18" r="15" fill="none" stroke="#e2e8f0" strokeWidth="3" />
            <circle cx="18" cy="18" r="15" fill="none" stroke="#22c55e" strokeWidth="3" strokeDasharray="82 18" strokeLinecap="round" />
          </svg>
          <span className="absolute inset-0 flex items-center justify-center text-[7px] font-bold text-green-600">82%</span>
        </div>
        <div className="flex-1 text-[8px]">
          <span className="text-slate-700">Passed: 14 · Failed: 3</span>
        </div>
        <div className="px-2 py-0.5 rounded bg-primary text-white text-[7px] font-medium">Fix Selected</div>
      </div>

      {/* README + Commit — all in same step */}
      <div className="border border-slate-200 rounded-lg bg-white p-2 flex items-center justify-between">
        <div>
          <p className="text-[8px] font-semibold text-slate-900">README.md</p>
          <p className="text-[7px] text-slate-500">Auto-generated and included in commit</p>
        </div>
        <div className="px-2 py-0.5 rounded border border-slate-200 bg-white text-[7px] text-slate-600">Show README</div>
      </div>

      <div>
        <p className="text-[8px] font-medium text-slate-700 mb-1">Commit Message</p>
        <div className="border border-slate-200 rounded bg-white p-1.5 text-[8px] text-slate-700 h-7">
          Add infrastructure code from ArchMe diagram
        </div>
      </div>

      <div className="w-full py-1.5 rounded-md bg-primary text-white text-[9px] font-medium text-center flex items-center justify-center gap-1">
        <GitBranch className="w-3 h-3" /> Commit & Push to Repository
      </div>
    </div>
  );
}

/* ─────────── Slide 5: Activities — Security Scan Detail ─────────── */
function SlideSecurityScan() {
  return (
    <div className="space-y-2.5">
      <div className="text-center">
        <h3 className="text-sm font-bold text-slate-900">Activities — Security Scan</h3>
        <p className="text-[10px] text-slate-500">Checkov scans Terraform and Kubernetes configs for misconfigurations</p>
      </div>

      <ActivityButtonBar active="scan" />

      <div className="flex items-center gap-4 p-3 rounded-xl bg-white border border-slate-200 shadow-sm">
        <div className="relative w-14 h-14">
          <svg className="w-14 h-14 -rotate-90" viewBox="0 0 36 36">
            <circle cx="18" cy="18" r="15" fill="none" stroke="#e2e8f0" strokeWidth="3" />
            <circle cx="18" cy="18" r="15" fill="none" stroke="#22c55e" strokeWidth="3" strokeDasharray="82 18" strokeLinecap="round" />
          </svg>
          <span className="absolute inset-0 flex items-center justify-center text-[10px] font-bold text-green-600">82%</span>
        </div>
        <div className="flex-1 space-y-1">
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-full bg-green-500" />
            <span className="text-[10px] font-medium text-slate-700">Passed: 14</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-full bg-red-500" />
            <span className="text-[10px] font-medium text-slate-700">Failed: 3</span>
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-2 space-y-2">
        <div>
          <p className="text-[9px] font-semibold text-slate-700 mb-1">main.tf — 2 failed checks</p>
          {[
            { id: "CKV_AZURE_35", desc: "Ensure storage account has secure transfer enabled" },
            { id: "CKV_AZURE_59", desc: "Ensure AKS uses RBAC" },
          ].map((c) => (
            <div key={c.id} className="flex items-center gap-2 p-1 rounded bg-red-50 border border-red-200 mb-0.5">
              <input type="checkbox" className="w-3 h-3" readOnly />
              <span className="text-[7px] font-mono text-red-700">{c.id}</span>
              <span className="text-[8px] text-slate-600 flex-1">{c.desc}</span>
            </div>
          ))}
        </div>
        <div>
          <p className="text-[9px] font-semibold text-slate-700 mb-1">monitoring.yaml — 1 failed check</p>
          <div className="flex items-center gap-2 p-1 rounded bg-red-50 border border-red-200">
            <input type="checkbox" className="w-3 h-3" readOnly />
            <span className="text-[7px] font-mono text-red-700">CKV_K8S_21</span>
            <span className="text-[8px] text-slate-600 flex-1">Default namespace should not be used</span>
          </div>
        </div>
        <div className="flex gap-2">
          <div className="px-2 py-1 rounded bg-slate-100 text-[8px] text-slate-600">Select All</div>
          <div className="px-2 py-1 rounded bg-primary text-white text-[8px] font-medium">Fix Selected</div>
        </div>
      </div>
    </div>
  );
}

/* ─────────── Slide 6: Activities — Cost Analysis Detail ─────────── */
function SlideCostAnalysis() {
  return (
    <div className="space-y-2.5">
      <div className="text-center">
        <h3 className="text-sm font-bold text-slate-900">Activities — Cost Analysis</h3>
        <p className="text-[10px] text-slate-500">Estimate monthly and yearly costs for all provisioned resources</p>
      </div>

      <ActivityButtonBar active="cost" />

      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-xl bg-green-50 border border-green-200 p-2 text-center">
          <p className="text-[8px] text-green-600 uppercase">Exact Price</p>
          <p className="text-sm font-bold text-green-700">$245.60</p>
          <p className="text-[7px] text-green-600">3 resources</p>
        </div>
        <div className="rounded-xl bg-amber-50 border border-amber-200 p-2 text-center">
          <p className="text-[8px] text-amber-600 uppercase">Estimated</p>
          <p className="text-sm font-bold text-amber-700">$89.00</p>
          <p className="text-[7px] text-amber-600">2 resources</p>
        </div>
        <div className="rounded-xl bg-slate-50 border border-slate-200 p-2 text-center">
          <p className="text-[8px] text-slate-500 uppercase">Needs Input</p>
          <p className="text-sm font-bold text-slate-700">$0.00</p>
          <p className="text-[7px] text-slate-500">1 resource</p>
        </div>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
        <table className="w-full text-[8px]">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200">
              <th className="text-left p-1.5 text-slate-500">Resource</th>
              <th className="text-right p-1.5 text-slate-500">Monthly</th>
              <th className="text-right p-1.5 text-slate-500">Yearly</th>
            </tr>
          </thead>
          <tbody>
            {[
              { name: "AKS Cluster (Standard_D4s_v3)", m: "$140.16", y: "$1,681.92" },
              { name: "Container Registry (Standard)", m: "$50.00", y: "$600.00" },
              { name: "Key Vault (Standard)", m: "$0.03", y: "$0.36" },
              { name: "Storage Account (Hot LRS)", m: "$21.00", y: "$252.00" },
              { name: "Log Analytics Workspace", m: "$34.41", y: "$412.92" },
            ].map((r) => (
              <tr key={r.name} className="border-b border-slate-100">
                <td className="p-1.5 text-slate-700">{r.name}</td>
                <td className="p-1.5 text-right text-slate-900 font-medium">{r.m}</td>
                <td className="p-1.5 text-right text-slate-900 font-medium">{r.y}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="rounded-lg bg-blue-50 border border-blue-200 p-2 flex items-center justify-between">
        <span className="text-[9px] font-semibold text-blue-800">Grand Total (Monthly)</span>
        <span className="text-sm font-bold text-blue-800">$245.60</span>
      </div>
    </div>
  );
}

/* ─────────── Slide 7: Commit Success ─────────── */
function SlideCommitSuccess() {
  return (
    <div className="space-y-4">
      <div className="text-center">
        <p className="text-xs font-bold text-slate-900">Commit & Push to Repository</p>
        <p className="text-[9px] text-slate-500">All generated infrastructure code committed</p>
      </div>

      <div className="max-w-sm mx-auto flex flex-col items-center gap-3 p-6 border border-green-200 rounded-lg bg-green-50">
        <div className="flex items-center gap-2 text-green-600">
          <div className="w-8 h-8 rounded-full bg-green-100 flex items-center justify-center">
            <Check className="w-5 h-5 text-green-600" />
          </div>
          <h3 className="text-sm font-semibold">Code Committed</h3>
        </div>
        <p className="text-[10px] text-slate-500 text-center">
          Successfully committed 8 file(s) to repository
        </p>
        <div className="text-[9px] text-slate-500 space-y-0.5 text-center">
          <p>main.tf · variables.tf · aks.tf · acr.tf</p>
          <p>keyvault.tf · storage.tf · monitoring.yaml · README.md</p>
        </div>
        <div className="px-4 py-2 rounded-md bg-primary text-white text-[10px] font-medium flex items-center gap-1.5">
          <Home className="w-3 h-3" /> Go to Home
        </div>
      </div>
    </div>
  );
}

const slides: Slide[] = [
  { step: 1, title: "Describe Architecture", subtitle: "Chat panel + live diagram generation (diagram step)", icon: Network, content: <SlideDescribeArchitecture /> },
  { step: 2, title: "Select Repository", subtitle: "Provider selection + empty repo validation (repository step)", icon: GitBranch, content: <SlideRepoSelection /> },
  { step: 3, title: "Components & Layers", subtitle: "Intent preview + extracted components (components step)", icon: Code, content: <SlideComponentsWithIntent /> },
  { step: 4, title: "Code + Activities + Commit", subtitle: "CodeEditor, ActivityPanel, README, commit (code step)", icon: FileCode, content: <SlideCodeReviewCommit /> },
  { step: 5, title: "Security Scan", subtitle: "Checkov scans for Terraform & K8s misconfigurations", icon: Shield, content: <SlideSecurityScan /> },
  { step: 6, title: "Cost Analysis", subtitle: "Monthly and yearly cost estimates for Azure resources", icon: DollarSign, content: <SlideCostAnalysis /> },
  { step: 7, title: "Committed", subtitle: "All infrastructure code pushed to repository", icon: CheckCircle2, content: <SlideCommitSuccess /> },
];

const SLIDE_DURATION = 5000;

function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function ArchMeWalkthrough() {
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
        <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center">
          <Icon className="w-4 h-4 text-primary" />
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
              className={`w-2 h-2 rounded-full transition-all ${i === currentSlide ? "bg-primary scale-125" : i < currentSlide ? "bg-primary/40" : "bg-slate-600"}`}
              title={s.title}
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
          <span className="text-[10px] text-slate-500 mr-2">ArchMe Walkthrough</span>
          <button className="p-1.5 text-white/70 hover:text-white transition-colors"><Maximize2 className="w-4 h-4" /></button>
        </div>
      </div>
    </div>
  );
}
