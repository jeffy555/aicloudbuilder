import { useState, useEffect, useCallback, useRef } from "react";
import {
  Play,
  Pause,
  Cloud,
  CloudCog,
  Folder,
  Search,
  Box,
  Layers,
  Network,
  ArrowRight,
  SkipBack,
  SkipForward,
  Maximize2,
  Volume2,
  RefreshCw,
  Home,
  FileCode,
  Package,
  Loader2,
  Check,
  GitBranch,
  Shield,
  ChevronRight,
} from "lucide-react";

interface Slide {
  step: number;
  title: string;
  subtitle: string;
  icon: React.ElementType;
  content: React.ReactNode;
}

/* ─────────── Step Indicator (mirrors real StepIndicator) ─────────── */
function MiniStepIndicator({ steps, currentStep }: { steps: { number: number; title: string }[]; currentStep: number }) {
  return (
    <div className="flex items-center justify-center gap-0 mb-3">
      {steps.map((step, i) => (
        <div key={step.number} className="flex items-center">
          <div className="flex flex-col items-center">
            <div
              className={`w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-bold ${
                step.number < currentStep
                  ? "bg-gradient-to-r from-blue-600 to-green-500 text-white"
                  : step.number === currentStep
                  ? "bg-gradient-to-r from-blue-600 to-green-500 text-white ring-2 ring-blue-300 scale-110"
                  : "bg-slate-200 text-slate-500"
              }`}
            >
              {step.number < currentStep ? <Check className="w-3 h-3" /> : step.number}
            </div>
            <span className="text-[7px] text-slate-400 mt-0.5 w-12 text-center truncate">{step.title}</span>
          </div>
          {i < steps.length - 1 && (
            <div className={`w-6 h-px mt-[-10px] ${step.number < currentStep ? "bg-gradient-to-r from-blue-500 to-green-500" : "bg-slate-200"}`} />
          )}
        </div>
      ))}
    </div>
  );
}

/* ─────────── Slide 1: Provider Selection ─────────── */
function SlideProviderSelection() {
  const steps = [
    { number: 1, title: "Provider" },
    { number: 2, title: "Repository" },
    { number: 3, title: "Cloud" },
    { number: 4, title: "Module" },
    { number: 5, title: "Backend" },
    { number: 6, title: "Generate" },
    { number: 7, title: "Review" },
    { number: 8, title: "Activities" },
  ];

  return (
    <div className="space-y-3">
      {/* Header — matches real TerraformWorkflow header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-lg bg-primary/10">
            <Cloud className="w-4 h-4 text-primary" />
          </div>
          <div>
            <h2 className="text-base font-bold text-slate-900">Terraform Workflow</h2>
            <p className="text-[10px] text-slate-500">Generate infrastructure as code for Azure, AWS, or GCP</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <span className="px-2 py-1 rounded-md text-[9px] text-slate-500 bg-white border border-slate-200 flex items-center gap-1">
            <RefreshCw className="w-2.5 h-2.5" /> Refresh
          </span>
          <span className="px-2 py-1 rounded-md text-[9px] text-slate-500 bg-white border border-slate-200 flex items-center gap-1">
            <Home className="w-2.5 h-2.5" /> Home
          </span>
        </div>
      </div>

      <MiniStepIndicator steps={steps} currentStep={1} />

      <div className="text-center mb-2">
        <h3 className="text-sm font-bold text-slate-900">Select Repository Provider</h3>
        <p className="text-[10px] text-slate-500">Choose where to store your Terraform configurations</p>
      </div>
      <div className="grid grid-cols-2 gap-3 max-w-sm mx-auto">
        <div className="rounded-xl border-2 border-green-500 bg-green-50 p-3 cursor-pointer ring-2 ring-green-300 transition-all">
          <div className="w-8 h-8 rounded-lg bg-green-100 flex items-center justify-center mb-2">
            <GitBranch className="w-4 h-4 text-green-600" />
          </div>
          <p className="text-xs font-semibold text-slate-900">GitHub</p>
          <p className="text-[9px] text-slate-500">Use GitHub repositories for your Terraform configurations</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-3 cursor-pointer hover:border-blue-300 transition-all">
          <div className="w-8 h-8 rounded-lg bg-blue-100 flex items-center justify-center mb-2">
            <Cloud className="w-4 h-4 text-blue-600" />
          </div>
          <p className="text-xs font-semibold text-slate-900">Azure DevOps</p>
          <p className="text-[9px] text-slate-500">Use Azure DevOps repositories for your infrastructure code</p>
        </div>
      </div>
    </div>
  );
}

/* ─────────── Slide 2: Repository + Cloud Provider ─────────── */
function SlideRepoAndCloud() {
  return (
    <div className="space-y-3">
      <div className="text-center">
        <h3 className="text-sm font-bold text-slate-900">Select Repository</h3>
        <p className="text-[10px] text-slate-500">Choose an existing repository or create a new one</p>
      </div>

      {/* RepositoryList mockup — matches real RadioGroup with FolderIcon */}
      <div className="max-w-sm mx-auto">
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden shadow-sm">
          <div className="px-3 py-2 border-b border-slate-100 bg-slate-50 flex items-center gap-2">
            <Search className="w-3 h-3 text-slate-400" />
            <span className="text-[10px] text-slate-400">Search repositories...</span>
            <span className="ml-auto text-[9px] text-slate-400">3 of 3</span>
          </div>
          <label className="flex items-center gap-3 px-3 py-2 bg-primary/5 border-b border-slate-100">
            <div className="w-3.5 h-3.5 rounded-full border-2 border-primary flex items-center justify-center"><div className="w-1.5 h-1.5 rounded-full bg-primary" /></div>
            <Folder className="w-3.5 h-3.5 text-slate-500" />
            <div className="flex-1"><span className="text-[10px] font-medium text-slate-800">my-azure-infra</span><span className="block text-[8px] text-slate-400">main · Updated 2 days ago</span></div>
          </label>
          <label className="flex items-center gap-3 px-3 py-2 border-b border-slate-100">
            <div className="w-3.5 h-3.5 rounded-full border-2 border-slate-300" />
            <Folder className="w-3.5 h-3.5 text-slate-400" />
            <div className="flex-1"><span className="text-[10px] text-slate-600">terraform-child-modules</span><span className="block text-[8px] text-slate-400">main · Updated 5 days ago</span></div>
          </label>
          <label className="flex items-center gap-3 px-3 py-2">
            <div className="w-3.5 h-3.5 rounded-full border-2 border-slate-300" />
            <Folder className="w-3.5 h-3.5 text-slate-400" />
            <div className="flex-1"><span className="text-[10px] text-slate-600">k8s-manifests</span><span className="block text-[8px] text-slate-400">main · Updated 1 week ago</span></div>
          </label>
        </div>
      </div>

      {/* Cloud Provider grid — matches real 3-card ProviderCard grid */}
      <div className="text-center mt-2">
        <h3 className="text-xs font-bold text-slate-900">Select Cloud Provider</h3>
        <p className="text-[9px] text-slate-500">Choose your target cloud platform</p>
      </div>
      <div className="grid grid-cols-3 gap-2 max-w-sm mx-auto">
        <div className="rounded-xl border-2 border-blue-500 bg-blue-50 p-2 text-center ring-2 ring-blue-300">
          <div className="w-6 h-6 rounded-lg bg-blue-100 flex items-center justify-center mx-auto mb-1"><Cloud className="w-3 h-3 text-blue-600" /></div>
          <p className="text-[9px] font-semibold">Azure</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-2 text-center">
          <div className="w-6 h-6 rounded-lg bg-yellow-100 flex items-center justify-center mx-auto mb-1"><CloudCog className="w-3 h-3 text-yellow-600" /></div>
          <p className="text-[9px] font-semibold">AWS</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-2 text-center">
          <div className="w-6 h-6 rounded-lg bg-green-100 flex items-center justify-center mx-auto mb-1"><Package className="w-3 h-3 text-green-600" /></div>
          <p className="text-[9px] font-semibold">GCP</p>
        </div>
      </div>
    </div>
  );
}

/* ─────────── Slide 3: Child Module Flow ─────────── */
/* Mirrors: Module select → Child Module selected → no backend → describe & generate */
function SlideChildModule() {
  const steps = [
    { number: 1, title: "Provider" },
    { number: 2, title: "Repository" },
    { number: 3, title: "Cloud" },
    { number: 4, title: "Module" },
    { number: 5, title: "Generate" },
    { number: 6, title: "Review" },
    { number: 7, title: "Activities" },
  ];

  return (
    <div className="space-y-2.5">
      {/* Approach label */}
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-violet-50 border border-violet-200 mx-auto w-fit">
        <Box className="w-3.5 h-3.5 text-violet-600" />
        <span className="text-[10px] font-bold text-violet-800">Approach 1: Child Module</span>
      </div>

      <MiniStepIndicator steps={steps} currentStep={4} />

      {/* Module selection — Child Module selected */}
      <div className="grid grid-cols-3 gap-2 max-w-sm mx-auto">
        <div className="rounded-xl border-2 border-violet-500 bg-violet-50 p-2 text-center ring-2 ring-violet-300">
          <div className="w-6 h-6 rounded-lg bg-violet-100 flex items-center justify-center mx-auto mb-1"><Box className="w-3 h-3 text-violet-600" /></div>
          <p className="text-[9px] font-semibold text-violet-900">Child Module</p>
          <p className="text-[7px] text-violet-600">Reusable module</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-2 text-center opacity-50">
          <div className="w-6 h-6 rounded-lg bg-slate-100 flex items-center justify-center mx-auto mb-1"><Layers className="w-3 h-3 text-slate-400" /></div>
          <p className="text-[9px] font-semibold text-slate-400">Standalone Root</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-2 text-center opacity-50">
          <div className="w-6 h-6 rounded-lg bg-slate-100 flex items-center justify-center mx-auto mb-1"><Network className="w-3 h-3 text-slate-400" /></div>
          <p className="text-[9px] font-semibold text-slate-400">Aggregated Root</p>
        </div>
      </div>

      {/* Key difference: No backend needed */}
      <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-2 max-w-sm mx-auto flex items-center gap-2">
        <Check className="w-3.5 h-3.5 text-emerald-600" />
        <p className="text-[9px] text-emerald-800"><span className="font-semibold">No backend configuration needed.</span> Child modules don't need state storage.</p>
      </div>

      {/* Describe & generate */}
      <div className="space-y-2 max-w-sm mx-auto">
        <div className="bg-slate-50 rounded-lg p-2 border border-slate-100">
          <p className="text-[9px] text-slate-500 font-semibold">AI Assistant</p>
          <p className="text-[9px] text-slate-700">Selected Child Module — Describe the infrastructure components you want to create.</p>
        </div>
        <div className="bg-primary/5 rounded-lg p-2 border border-primary/10 ml-6">
          <p className="text-[9px] text-primary font-semibold">You</p>
          <p className="text-[9px] text-slate-700">Create a reusable Azure storage account module with variables for name, location, replication type, and tags.</p>
        </div>
      </div>

      {/* Generated files preview */}
      <div className="max-w-sm mx-auto rounded-lg border border-slate-200 bg-slate-900 p-2 font-mono text-[8px] text-slate-300 max-h-[50px] overflow-hidden">
        <div><span className="text-purple-400">variable</span> <span className="text-yellow-300">"storage_account_name"</span> {"{ type = string }"}</div>
        <div><span className="text-purple-400">variable</span> <span className="text-yellow-300">"location"</span> {"{ type = string, default = \"eastus\" }"}</div>
        <div><span className="text-purple-400">resource</span> <span className="text-green-400">"azurerm_storage_account"</span> <span className="text-yellow-300">"this"</span> {"{ ... }"}</div>
      </div>
    </div>
  );
}

/* ─────────── Slide 4: Standalone Root Flow ─────────── */
/* Mirrors: Module select → Standalone Root → Backend config → Describe & Generate */
function SlideStandaloneRoot() {
  const steps = [
    { number: 1, title: "Provider" },
    { number: 2, title: "Repository" },
    { number: 3, title: "Cloud" },
    { number: 4, title: "Module" },
    { number: 5, title: "Backend" },
    { number: 6, title: "Generate" },
    { number: 7, title: "Review" },
    { number: 8, title: "Activities" },
  ];

  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-blue-50 border border-blue-200 mx-auto w-fit">
        <Layers className="w-3.5 h-3.5 text-blue-600" />
        <span className="text-[10px] font-bold text-blue-800">Approach 2: Standalone Root Module</span>
      </div>

      <MiniStepIndicator steps={steps} currentStep={5} />

      {/* Module selection — Standalone Root selected */}
      <div className="grid grid-cols-3 gap-2 max-w-sm mx-auto">
        <div className="rounded-xl border border-slate-200 bg-white p-2 text-center opacity-50">
          <div className="w-6 h-6 rounded-lg bg-slate-100 flex items-center justify-center mx-auto mb-1"><Box className="w-3 h-3 text-slate-400" /></div>
          <p className="text-[9px] font-semibold text-slate-400">Child Module</p>
        </div>
        <div className="rounded-xl border-2 border-blue-500 bg-blue-50 p-2 text-center ring-2 ring-blue-300">
          <div className="w-6 h-6 rounded-lg bg-blue-100 flex items-center justify-center mx-auto mb-1"><Layers className="w-3 h-3 text-blue-600" /></div>
          <p className="text-[9px] font-semibold text-blue-900">Standalone Root</p>
          <p className="text-[7px] text-blue-600">Root config</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-2 text-center opacity-50">
          <div className="w-6 h-6 rounded-lg bg-slate-100 flex items-center justify-center mx-auto mb-1"><Network className="w-3 h-3 text-slate-400" /></div>
          <p className="text-[9px] font-semibold text-slate-400">Aggregated Root</p>
        </div>
      </div>

      {/* Backend config form — compact version */}
      <div className="max-w-sm mx-auto rounded-lg border border-slate-200 bg-white p-3 space-y-2">
        <p className="text-[10px] font-bold text-slate-800">Configure Terraform Backend (Azure)</p>
        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className="text-[8px] font-semibold text-slate-600">Resource Group <span className="text-red-500">*</span></label>
            <div className="h-6 px-2 border border-slate-300 rounded text-[9px] text-slate-900 flex items-center">terraform-state-rg</div>
          </div>
          <div>
            <label className="text-[8px] font-semibold text-slate-600">Storage Account <span className="text-red-500">*</span></label>
            <div className="h-6 px-2 border border-slate-300 rounded text-[9px] text-slate-900 flex items-center">tfstate20250217</div>
          </div>
          <div>
            <label className="text-[8px] font-semibold text-slate-600">Container <span className="text-red-500">*</span></label>
            <div className="h-6 px-2 border border-slate-300 rounded text-[9px] text-slate-900 flex items-center">tfstate</div>
          </div>
        </div>
        <div className="flex gap-2">
          <div className="flex-1 px-2 py-1 rounded bg-primary text-white text-[9px] font-medium text-center">Create Backend</div>
          <div className="flex-1 px-2 py-1 rounded border border-slate-200 text-slate-600 text-[9px] font-medium text-center">Skip Backend</div>
        </div>
      </div>

      {/* Describe & generate */}
      <div className="max-w-sm mx-auto bg-primary/5 rounded-lg p-2 border border-primary/10">
        <p className="text-[9px] text-primary font-semibold">You</p>
        <p className="text-[9px] text-slate-700">Create Terraform for Azure Resource Group, Storage Account, and App Service with Linux plan in East US.</p>
      </div>
      <div className="text-center">
        <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary/5 border border-primary/10">
          <Loader2 className="w-3 h-3 animate-spin text-primary" />
          <span className="text-[9px] text-slate-600">Generating Terraform configuration...</span>
        </div>
      </div>
    </div>
  );
}

/* ─────────── Slide 5: Aggregated Root Flow ─────────── */
/* Mirrors: Module select → Aggregated Root → Child Repo → Resource extraction → Root Repo → Backend → Resource Validation */
function SlideAggregatedRoot() {
  const aggSteps = [
    { number: 1, title: "Provider" },
    { number: 2, title: "Cloud" },
    { number: 3, title: "Module" },
    { number: 4, title: "Child Repo" },
    { number: 5, title: "Root Repo" },
    { number: 6, title: "Backend" },
    { number: 7, title: "Resources" },
    { number: 8, title: "Generate" },
    { number: 9, title: "Activities" },
    { number: 10, title: "Commit" },
  ];

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-orange-50 border border-orange-200 mx-auto w-fit">
        <Network className="w-3.5 h-3.5 text-orange-600" />
        <span className="text-[10px] font-bold text-orange-800">Approach 3: Aggregated Root Module</span>
      </div>

      {/* Aggregated Root has its own step flow */}
      <MiniStepIndicator steps={aggSteps.slice(0, 8)} currentStep={4} />

      {/* Module selection — Aggregated Root selected */}
      <div className="grid grid-cols-3 gap-2 max-w-sm mx-auto">
        <div className="rounded-xl border border-slate-200 bg-white p-1.5 text-center opacity-50">
          <div className="w-5 h-5 rounded-lg bg-slate-100 flex items-center justify-center mx-auto mb-0.5"><Box className="w-2.5 h-2.5 text-slate-400" /></div>
          <p className="text-[8px] font-semibold text-slate-400">Child Module</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-1.5 text-center opacity-50">
          <div className="w-5 h-5 rounded-lg bg-slate-100 flex items-center justify-center mx-auto mb-0.5"><Layers className="w-2.5 h-2.5 text-slate-400" /></div>
          <p className="text-[8px] font-semibold text-slate-400">Standalone Root</p>
        </div>
        <div className="rounded-xl border-2 border-orange-500 bg-orange-50 p-1.5 text-center ring-2 ring-orange-300">
          <div className="w-5 h-5 rounded-lg bg-orange-100 flex items-center justify-center mx-auto mb-0.5"><Network className="w-2.5 h-2.5 text-orange-600" /></div>
          <p className="text-[8px] font-semibold text-orange-900">Aggregated Root</p>
        </div>
      </div>

      {/* Child repo selected + resources extracted */}
      <div className="rounded-lg border border-green-200 bg-green-50 p-2 max-w-sm mx-auto flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Package className="w-3.5 h-3.5 text-green-600" />
          <div>
            <p className="text-[9px] font-medium text-green-900">Child Module Repository Selected</p>
            <p className="text-[8px] text-green-700">terraform-child-modules</p>
          </div>
        </div>
        <span className="text-[8px] text-green-700 px-1.5 py-0.5 rounded border border-green-200 bg-white">Change</span>
      </div>

      {/* Extracted resources — matches real blue banner with resource pills */}
      <div className="rounded-lg border border-blue-200 bg-blue-50 p-2 max-w-sm mx-auto">
        <div className="flex items-center gap-1.5 mb-1.5">
          <Package className="w-3 h-3 text-blue-600" />
          <p className="text-[9px] font-semibold text-blue-900">Available Child Module Resources</p>
        </div>
        <div className="flex flex-wrap gap-1">
          {["azurerm_resource_group", "azurerm_storage_account", "azurerm_virtual_network", "azurerm_subnet", "azurerm_network_security_group"].map((r) => (
            <span key={r} className="px-1.5 py-0.5 rounded bg-white border border-blue-300 text-[7px] font-mono text-blue-800">{r}</span>
          ))}
        </div>
      </div>

      {/* Resource validation — matches real green validation result */}
      <div className="rounded-lg border border-green-200 bg-green-50 p-2 max-w-sm mx-auto flex items-center gap-2">
        <Check className="w-3.5 h-3.5 text-green-600" />
        <div>
          <p className="text-[9px] font-semibold text-green-900">Validation Successful</p>
          <p className="text-[8px] text-green-700">All requested resources are available in the child module.</p>
        </div>
      </div>

      <div className="flex justify-center">
        <div className="px-3 py-1 rounded-md bg-primary text-white text-[9px] font-medium flex items-center gap-1">
          Continue to Generate <ChevronRight className="w-3 h-3" />
        </div>
      </div>
    </div>
  );
}

/* ─────────── Slide 6: Review & Edit (CodeEditor) ─────────── */
function SlideReviewEdit() {
  return (
    <div className="space-y-3">
      <div className="text-center">
        <h3 className="text-sm font-bold text-slate-900">Review & Edit</h3>
        <p className="text-[10px] text-slate-500">Review and edit your generated Terraform configuration files</p>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white overflow-hidden shadow-sm">
        <div className="flex border-b border-slate-200 bg-slate-50">
          <div className="px-3 py-1.5 text-[10px] font-medium text-primary border-b-2 border-primary bg-white flex items-center gap-1">
            <FileCode className="w-3 h-3" /> main.tf
          </div>
          <div className="px-3 py-1.5 text-[10px] text-slate-500 flex items-center gap-1">
            <FileCode className="w-3 h-3" /> variables.tf
          </div>
          <div className="px-3 py-1.5 text-[10px] text-slate-500 flex items-center gap-1">
            <FileCode className="w-3 h-3" /> outputs.tf
          </div>
          <div className="px-3 py-1.5 text-[10px] text-slate-500 flex items-center gap-1">
            <FileCode className="w-3 h-3" /> backend.tf
          </div>
        </div>
        <div className="p-3 font-mono text-[9px] leading-relaxed bg-slate-900 text-slate-300 max-h-[180px] overflow-hidden">
          <div><span className="text-purple-400">resource</span> <span className="text-green-400">"azurerm_resource_group"</span> <span className="text-yellow-300">"main"</span> {"{"}</div>
          <div className="pl-4">name     = <span className="text-green-400">"rg-myapp-eastus"</span></div>
          <div className="pl-4">location = <span className="text-green-400">"eastus"</span></div>
          <div>{"}"}</div>
          <div className="mt-1"><span className="text-purple-400">resource</span> <span className="text-green-400">"azurerm_storage_account"</span> <span className="text-yellow-300">"main"</span> {"{"}</div>
          <div className="pl-4">name                     = <span className="text-green-400">"stmyappeastus"</span></div>
          <div className="pl-4">resource_group_name      = azurerm_resource_group.main.name</div>
          <div className="pl-4">location                 = azurerm_resource_group.main.location</div>
          <div className="pl-4">account_tier             = <span className="text-green-400">"Standard"</span></div>
          <div className="pl-4">account_replication_type  = <span className="text-green-400">"LRS"</span></div>
          <div>{"}"}</div>
          <div className="mt-1"><span className="text-purple-400">resource</span> <span className="text-green-400">"azurerm_service_plan"</span> <span className="text-yellow-300">"main"</span> {"{"}</div>
          <div className="pl-4">name                = <span className="text-green-400">"plan-myapp-eastus"</span></div>
          <div className="pl-4">...</div>
        </div>
      </div>

      <div className="flex gap-2 justify-center">
        <div className="px-3 py-1.5 rounded-md border border-slate-200 text-[10px] text-slate-600 font-medium">← Back</div>
        <div className="px-3 py-1.5 rounded-md bg-primary text-white text-[10px] font-medium">Continue to Activities →</div>
      </div>
    </div>
  );
}

/* ─────────── Activity button bar (shared across activity slides) ─────────── */
function ActivityButtonBar({ active }: { active: "security" | "cost" | "best" | "draw" }) {
  const tabs = [
    { id: "security", label: "Security Scan", icon: Shield, color: "emerald" },
    { id: "cost", label: "Cost Analysis", icon: Cloud, color: "blue" },
    { id: "best", label: "Best Approach", icon: Layers, color: "amber" },
    { id: "draw", label: "Draw", icon: Network, color: "violet" },
  ] as const;

  return (
    <div className="flex flex-wrap gap-1.5 justify-center">
      {tabs.map((tab) => {
        const Icon = tab.icon;
        const isActive = tab.id === active;
        return (
          <div
            key={tab.id}
            className={`flex items-center gap-1 px-2.5 py-1.5 rounded-md text-[9px] font-medium border transition-all ${
              isActive
                ? "bg-primary text-white border-primary shadow-sm"
                : "bg-white text-slate-500 border-slate-200"
            }`}
          >
            <Icon className="w-3 h-3" />
            {tab.label}
          </div>
        );
      })}
    </div>
  );
}

/* ─────────── Slide 7: Security Scan ─────────── */
/* Mirrors: CheckovScanner — summary card with pass %, failed checks grouped by file, fix button */
function SlideSecurityScan() {
  return (
    <div className="space-y-2.5">
      <div className="text-center">
        <h3 className="text-sm font-bold text-slate-900">Activities — Security Scan</h3>
        <p className="text-[10px] text-slate-500">Checkov runs security checks and identifies misconfigurations</p>
      </div>

      <ActivityButtonBar active="security" />

      {/* Summary card — matches real CheckovScanner summary */}
      <div className="rounded-lg border border-slate-200 bg-white p-3 space-y-2">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center">
            <Shield className="w-5 h-5 text-amber-600" />
          </div>
          <div className="flex-1">
            <div className="flex items-center justify-between">
              <span className="text-sm font-bold text-slate-900">80%</span>
              <span className="text-[9px] text-slate-500">12 of 15 checks passed</span>
            </div>
            <div className="h-2 w-full rounded-full bg-slate-200 mt-1">
              <div className="h-full rounded-full bg-gradient-to-r from-amber-400 to-emerald-500" style={{ width: "80%" }} />
            </div>
          </div>
        </div>
        <div className="flex gap-3 text-[8px]">
          <span className="text-emerald-600 font-medium">✓ 12 passed</span>
          <span className="text-red-500 font-medium">✗ 3 failed</span>
          <span className="text-slate-400">⊘ 0 skipped</span>
          <span className="text-slate-400 ml-auto">Total: 15 checks</span>
        </div>
      </div>

      {/* Failed checks — matches real file-grouped collapsible cards */}
      <div className="rounded-lg border border-red-200 bg-white overflow-hidden">
        <div className="px-3 py-2 bg-red-50 border-b border-red-100 flex items-center justify-between">
          <span className="text-[10px] font-semibold text-red-800">Failed Checks</span>
          <div className="flex items-center gap-2">
            <span className="text-[8px] text-red-600">Select All</span>
            <div className="px-2 py-0.5 rounded bg-emerald-600 text-white text-[8px] font-medium">Fix Selected (3)</div>
          </div>
        </div>
        <div className="divide-y divide-red-50">
          {/* File group: main.tf */}
          <div className="px-3 py-2">
            <div className="flex items-center gap-2 mb-1.5">
              <div className="w-3 h-3 rounded border border-red-300 bg-red-50 flex items-center justify-center"><Check className="w-2 h-2 text-red-500" /></div>
              <span className="text-[9px] font-semibold text-slate-800">main.tf</span>
              <span className="text-[7px] px-1.5 py-0.5 rounded-full bg-red-100 text-red-600 font-semibold">2 failed</span>
            </div>
            <div className="ml-5 space-y-1.5">
              <div className="rounded border border-red-100 p-1.5 bg-red-50/50">
                <div className="flex items-center gap-1.5">
                  <span className="text-[8px] font-medium text-slate-700">Ensure storage account has access logging</span>
                  <span className="text-[7px] px-1 py-0.5 rounded bg-slate-100 text-slate-500 font-mono">CKV_AZURE_35</span>
                </div>
                <p className="text-[7px] text-red-600 mt-0.5">Resource: azurerm_storage_account.main</p>
              </div>
              <div className="rounded border border-red-100 p-1.5 bg-red-50/50">
                <div className="flex items-center gap-1.5">
                  <span className="text-[8px] font-medium text-slate-700">Ensure storage account disallows public access</span>
                  <span className="text-[7px] px-1 py-0.5 rounded bg-slate-100 text-slate-500 font-mono">CKV_AZURE_59</span>
                </div>
                <p className="text-[7px] text-red-600 mt-0.5">Resource: azurerm_storage_account.main</p>
              </div>
            </div>
          </div>
          {/* File group: backend.tf */}
          <div className="px-3 py-2">
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded border border-red-300 bg-red-50 flex items-center justify-center"><Check className="w-2 h-2 text-red-500" /></div>
              <span className="text-[9px] font-semibold text-slate-800">backend.tf</span>
              <span className="text-[7px] px-1.5 py-0.5 rounded-full bg-red-100 text-red-600 font-semibold">1 failed</span>
            </div>
            <div className="ml-5 mt-1.5">
              <div className="rounded border border-red-100 p-1.5 bg-red-50/50">
                <div className="flex items-center gap-1.5">
                  <span className="text-[8px] font-medium text-slate-700">Ensure backend uses encryption</span>
                  <span className="text-[7px] px-1 py-0.5 rounded bg-slate-100 text-slate-500 font-mono">CKV_AZURE_36</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─────────── Slide 8: Cost Analysis ─────────── */
/* Mirrors: CostAnalyzer — summary cards, resource table, grand total */
function SlideCostAnalysis() {
  return (
    <div className="space-y-2.5">
      <div className="text-center">
        <h3 className="text-sm font-bold text-slate-900">Activities — Cost Analysis</h3>
        <p className="text-[10px] text-slate-500">Analyze estimated monthly and yearly costs for Azure resources</p>
      </div>

      <ActivityButtonBar active="cost" />

      {/* Profile selector */}
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-1.5">
          <span className="text-[9px] font-medium text-slate-600">Usage Profile:</span>
          <div className="px-2 py-0.5 rounded border border-slate-200 bg-white text-[9px] text-slate-700 font-medium">Medium ▾</div>
        </div>
        <span className="text-[8px] text-slate-400">3 resources analyzed</span>
      </div>

      {/* Summary cards — matches real 3-column grid */}
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-2 text-center">
          <p className="text-[8px] text-emerald-600 font-semibold">Exact Cost</p>
          <p className="text-base font-bold text-emerald-700">$12.40</p>
          <p className="text-[7px] text-emerald-500">1 resource</p>
        </div>
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-center">
          <p className="text-[8px] text-amber-600 font-semibold">Estimated</p>
          <p className="text-base font-bold text-amber-700">$32.80</p>
          <p className="text-[7px] text-amber-500">2 resources</p>
        </div>
        <div className="rounded-lg border border-red-200 bg-red-50 p-2 text-center">
          <p className="text-[8px] text-red-600 font-semibold">Needs Input</p>
          <p className="text-base font-bold text-red-700">0</p>
          <p className="text-[7px] text-red-500">0 resources</p>
        </div>
      </div>

      {/* Resource table — matches real table layout */}
      <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
        <div className="grid grid-cols-[1fr_70px_60px_70px_70px] gap-1 px-3 py-1.5 bg-slate-50 border-b border-slate-200 text-[8px] font-semibold text-slate-500">
          <span>Resource</span>
          <span>Service</span>
          <span>Status</span>
          <span className="text-right">Monthly</span>
          <span className="text-right">Yearly</span>
        </div>
        {[
          { name: "rg-myapp-eastus", type: "azurerm_resource_group", service: "Resource Group", status: "Exact", statusColor: "emerald", monthly: "$0.00", yearly: "$0.00" },
          { name: "stmyappeastus", type: "azurerm_storage_account", service: "Storage", status: "Estimated", statusColor: "amber", monthly: "$12.40", yearly: "$148.80" },
          { name: "plan-myapp-eastus", type: "azurerm_service_plan", service: "App Service", status: "Estimated", statusColor: "amber", monthly: "$32.80", yearly: "$393.60" },
        ].map((r) => (
          <div key={r.name} className="grid grid-cols-[1fr_70px_60px_70px_70px] gap-1 px-3 py-1.5 border-b border-slate-100 items-center">
            <div>
              <p className="text-[9px] font-medium text-slate-800">{r.name}</p>
              <p className="text-[7px] text-slate-400">{r.type}</p>
            </div>
            <span className="text-[8px] text-slate-600">{r.service}</span>
            <span className={`text-[7px] px-1 py-0.5 rounded-full bg-${r.statusColor}-100 text-${r.statusColor}-600 font-semibold`}>{r.status}</span>
            <span className="text-[9px] font-medium text-slate-800 text-right">{r.monthly}</span>
            <span className="text-[9px] font-medium text-slate-800 text-right">{r.yearly}</span>
          </div>
        ))}
      </div>

      {/* Grand total — matches real blue alert */}
      <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 flex items-center justify-between">
        <div>
          <p className="text-[9px] font-semibold text-blue-800">Total Estimated Cost</p>
          <p className="text-[7px] text-blue-600">3 resources · Medium profile</p>
        </div>
        <div className="flex gap-4">
          <div className="text-right">
            <p className="text-[8px] text-blue-500">Monthly</p>
            <p className="text-lg font-bold text-blue-700">$45.20</p>
          </div>
          <div className="text-right">
            <p className="text-[8px] text-emerald-500">Yearly</p>
            <p className="text-lg font-bold text-emerald-700">$542.40</p>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─────────── Slide 9: Best Approach (Refactor Validator) ─────────── */
/* Mirrors: RefactorValidator — validation results, issues list, fix suggestions */
function SlideBestApproach() {
  return (
    <div className="space-y-2.5">
      <div className="text-center">
        <h3 className="text-sm font-bold text-slate-900">Activities — Best Approach</h3>
        <p className="text-[10px] text-slate-500">Validate Terraform against best practices and auto-fix issues</p>
      </div>

      <ActivityButtonBar active="best" />

      {/* Validation result — matches real yellow "Issues Found" card */}
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Shield className="w-5 h-5 text-amber-600" />
          <div>
            <p className="text-[11px] font-semibold text-amber-900">Issues Found</p>
            <div className="flex gap-3 text-[8px] mt-0.5">
              <span className="text-slate-600">Files checked: <span className="font-bold">4</span></span>
              <span className="text-slate-600">Total issues: <span className="font-bold">3</span></span>
              <span className="text-red-600">Errors: <span className="font-bold">1</span></span>
              <span className="text-amber-600">Warnings: <span className="font-bold">2</span></span>
            </div>
          </div>
        </div>
        <div className="px-2.5 py-1 rounded-md bg-emerald-600 text-white text-[9px] font-medium flex items-center gap-1">
          <RefreshCw className="w-2.5 h-2.5" /> Fix
        </div>
      </div>

      {/* Issues list — matches real severity-colored cards */}
      <div className="space-y-1.5">
        {/* Error */}
        <div className="rounded-lg border-l-4 border-l-red-500 border border-red-200 bg-red-50 px-3 py-2">
          <div className="flex items-center gap-1.5">
            <span className="text-[9px] font-semibold text-red-800">Missing required_providers block</span>
            <span className="text-[7px] px-1 py-0.5 rounded bg-red-100 text-red-600 font-semibold">ERROR</span>
          </div>
          <p className="text-[8px] text-red-700 mt-0.5">File: main.tf · Line 1</p>
          <p className="text-[8px] text-slate-600 mt-0.5">💡 Add a terraform {"{"} required_providers {"{"} azurerm = {"{"} ... {"}"} {"}"} {"}"} block</p>
        </div>
        {/* Warning 1 */}
        <div className="rounded-lg border-l-4 border-l-amber-500 border border-amber-200 bg-amber-50 px-3 py-2">
          <div className="flex items-center gap-1.5">
            <span className="text-[9px] font-semibold text-amber-800">Resource missing description tags</span>
            <span className="text-[7px] px-1 py-0.5 rounded bg-amber-100 text-amber-600 font-semibold">WARNING</span>
          </div>
          <p className="text-[8px] text-amber-700 mt-0.5">File: main.tf · azurerm_storage_account.main</p>
          <p className="text-[8px] text-slate-600 mt-0.5">💡 Add tags with environment, project, and managed_by keys</p>
        </div>
        {/* Warning 2 */}
        <div className="rounded-lg border-l-4 border-l-amber-500 border border-amber-200 bg-amber-50 px-3 py-2">
          <div className="flex items-center gap-1.5">
            <span className="text-[9px] font-semibold text-amber-800">Variable missing description attribute</span>
            <span className="text-[7px] px-1 py-0.5 rounded bg-amber-100 text-amber-600 font-semibold">WARNING</span>
          </div>
          <p className="text-[8px] text-amber-700 mt-0.5">File: variables.tf · variable "location"</p>
        </div>
      </div>

      {/* Fix summary — matches real blue fix summary card */}
      <div className="rounded-lg border border-blue-200 bg-blue-50 p-2.5 flex items-center gap-2">
        <Check className="w-4 h-4 text-blue-600" />
        <div className="flex-1">
          <p className="text-[9px] font-semibold text-blue-800">Fix Summary</p>
          <div className="flex gap-3 text-[8px] mt-0.5">
            <span className="text-slate-600">Total: <span className="font-bold">3</span></span>
            <span className="text-emerald-600">Fixed: <span className="font-bold">3</span></span>
            <span className="text-red-600">Failed: <span className="font-bold">0</span></span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─────────── Slide 10: Draw (Architecture Diagram) ─────────── */
/* Mirrors: ArchitectureDiagram — Mermaid diagram, resource/relationship tables */
function SlideDraw() {
  return (
    <div className="space-y-2.5">
      <div className="text-center">
        <h3 className="text-sm font-bold text-slate-900">Activities — Architecture Diagram</h3>
        <p className="text-[10px] text-slate-500">Generate Mermaid architecture diagrams from your Terraform resources</p>
      </div>

      <ActivityButtonBar active="draw" />

      {/* Diagram type selector */}
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-1.5">
          <span className="text-[9px] font-medium text-slate-600">Diagram Type:</span>
          <div className="px-2 py-0.5 rounded border border-slate-200 bg-white text-[9px] text-slate-700 font-medium">flowchart ▾</div>
        </div>
        <div className="flex gap-1">
          <div className="px-2 py-0.5 rounded border border-slate-200 bg-white text-[8px] text-slate-500">Copy</div>
          <div className="px-2 py-0.5 rounded border border-slate-200 bg-white text-[8px] text-slate-500">Download JPG</div>
          <div className="px-2 py-0.5 rounded border border-slate-200 bg-white text-[8px] text-slate-500">Enlarge</div>
        </div>
      </div>

      {/* Mermaid diagram mockup — flowchart with Azure resources */}
      <div className="rounded-lg border border-slate-200 bg-white p-3 min-h-[140px]">
        <div className="flex flex-col items-center gap-3">
          {/* Resource Group at top */}
          <div className="px-4 py-1.5 rounded-lg bg-blue-100 border-2 border-blue-400 text-[9px] font-semibold text-blue-800">
            azurerm_resource_group.main
          </div>
          {/* Arrows down */}
          <div className="flex gap-8 items-start">
            <div className="flex flex-col items-center gap-1">
              <div className="w-px h-4 bg-slate-400" />
              <span className="text-[7px] text-slate-400">contains</span>
              <div className="w-px h-4 bg-slate-400" />
              <div className="px-3 py-1.5 rounded-lg bg-emerald-100 border-2 border-emerald-400 text-[8px] font-semibold text-emerald-800">
                azurerm_storage_account
              </div>
              <div className="w-px h-3 bg-slate-300" />
              <div className="px-2.5 py-1 rounded-lg bg-emerald-50 border border-emerald-300 text-[7px] text-emerald-700">
                blob_container
              </div>
            </div>
            <div className="flex flex-col items-center gap-1">
              <div className="w-px h-4 bg-slate-400" />
              <span className="text-[7px] text-slate-400">contains</span>
              <div className="w-px h-4 bg-slate-400" />
              <div className="px-3 py-1.5 rounded-lg bg-violet-100 border-2 border-violet-400 text-[8px] font-semibold text-violet-800">
                azurerm_service_plan
              </div>
              <div className="w-px h-3 bg-slate-300" />
              <div className="px-2.5 py-1 rounded-lg bg-violet-50 border border-violet-300 text-[7px] text-violet-700">
                linux_web_app
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Resource & Relationship summary — matches real tables */}
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-lg border border-slate-200 bg-white p-2">
          <p className="text-[9px] font-semibold text-slate-700 mb-1">Resources (5)</p>
          <div className="space-y-0.5 text-[8px]">
            <div className="flex items-center gap-1"><div className="w-2 h-2 rounded bg-blue-400" /><span className="text-slate-600">resource_group</span></div>
            <div className="flex items-center gap-1"><div className="w-2 h-2 rounded bg-emerald-400" /><span className="text-slate-600">storage_account</span></div>
            <div className="flex items-center gap-1"><div className="w-2 h-2 rounded bg-emerald-300" /><span className="text-slate-600">blob_container</span></div>
            <div className="flex items-center gap-1"><div className="w-2 h-2 rounded bg-violet-400" /><span className="text-slate-600">service_plan</span></div>
            <div className="flex items-center gap-1"><div className="w-2 h-2 rounded bg-violet-300" /><span className="text-slate-600">linux_web_app</span></div>
          </div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-2">
          <p className="text-[9px] font-semibold text-slate-700 mb-1">Relationships (4)</p>
          <div className="space-y-0.5 text-[8px] text-slate-600">
            <p>resource_group → storage_account</p>
            <p>resource_group → service_plan</p>
            <p>storage_account → blob_container</p>
            <p>service_plan → linux_web_app</p>
          </div>
          <p className="text-[7px] text-slate-400 mt-1">Cloud: Azure · Categories: 3</p>
        </div>
      </div>
    </div>
  );
}

/* ─────────── Slide 11: Commit & Push ─────────── */
function SlideCommit() {
  return (
    <div className="space-y-4">
      <div className="text-center">
        <h3 className="text-sm font-bold text-slate-900">Commit & Push</h3>
        <p className="text-[10px] text-slate-500">Commit your Terraform configuration to the repository</p>
      </div>

      <div className="flex gap-3 justify-center">
        <div className="px-4 py-2 rounded-md border border-slate-200 text-[11px] text-slate-600 font-medium">← Back</div>
        <div className="px-4 py-2 rounded-md bg-primary text-white text-[11px] font-medium">Commit & Push →</div>
      </div>

      <div className="text-center text-[10px] text-slate-500">Please run the security scan before committing</div>

      {/* Commit success */}
      <div className="max-w-md mx-auto flex flex-col items-center gap-3 p-5 border border-green-200 rounded-lg bg-green-50">
        <div className="flex items-center gap-2 text-green-600">
          <div className="w-6 h-6 rounded-full bg-green-100 flex items-center justify-center">
            <Check className="w-4 h-4 text-green-600" />
          </div>
          <h3 className="text-sm font-semibold">Successfully Committed!</h3>
        </div>
        <p className="text-[10px] text-slate-500 text-center">
          Your Terraform configuration has been committed to the repository.
        </p>
        <div className="px-4 py-2 rounded-md bg-primary text-white text-[10px] font-medium flex items-center gap-1.5">
          <Home className="w-3 h-3" /> Go to Home
        </div>
      </div>
    </div>
  );
}

const slides: Slide[] = [
  {
    step: 1,
    title: "Connect Your Repo",
    subtitle: "Link GitHub or Azure DevOps — your code never leaves your own repository",
    icon: GitBranch,
    content: <SlideProviderSelection />,
  },
  {
    step: 2,
    title: "Pick Cloud & Repo",
    subtitle: "Choose Azure, AWS, or GCP — multi-cloud from the same workflow, zero re-learning",
    icon: Cloud,
    content: <SlideRepoAndCloud />,
  },
  {
    step: 3,
    title: "Child Module",
    subtitle: "Build a reusable module once, reference it everywhere — no backend provisioning needed",
    icon: Box,
    content: <SlideChildModule />,
  },
  {
    step: 4,
    title: "Standalone Root",
    subtitle: "State backend auto-provisioned in your cloud — backend.tf generated and validated instantly",
    icon: Layers,
    content: <SlideStandaloneRoot />,
  },
  {
    step: 5,
    title: "Aggregated Root",
    subtitle: "Compose multiple child modules with live resource validation before a single line is written",
    icon: Network,
    content: <SlideAggregatedRoot />,
  },
  {
    step: 6,
    title: "Review & Edit Live",
    subtitle: "Every .tf file opens in the built-in editor — modify, save, and re-scan without leaving the page",
    icon: FileCode,
    content: <SlideReviewEdit />,
  },
  {
    step: 7,
    title: "Security Scan",
    subtitle: "Checkov runs 100+ checks the moment files generate — one-click AI fix for every failure",
    icon: Shield,
    content: <SlideSecurityScan />,
  },
  {
    step: 8,
    title: "Real-Time Cost",
    subtitle: "Live Azure / AWS / GCP pricing per resource — monthly & yearly breakdown before you commit a byte",
    icon: Cloud,
    content: <SlideCostAnalysis />,
  },
  {
    step: 9,
    title: "Best Practices",
    subtitle: "AI validates naming, structure, and Terraform idioms — auto-fixes warnings so your PR is clean",
    icon: Layers,
    content: <SlideBestApproach />,
  },
  {
    step: 10,
    title: "Architecture Diagram",
    subtitle: "Auto-generated resource relationship diagram — share with stakeholders before infra exists",
    icon: Network,
    content: <SlideDraw />,
  },
  {
    step: 11,
    title: "Commit & Done",
    subtitle: "AI writes the commit message — push directly to your branch, session archived for audit",
    icon: Package,
    content: <SlideCommit />,
  },
];

const SLIDE_DURATION = 5000;

function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function TerraformWalkthrough() {
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
    const newSlide = Math.min(slides.length - 1, Math.floor((pct / 100) * slides.length));
    setCurrentSlide(newSlide);
  };

  if (!slides || slides.length === 0) return null;
  const safeIndex = Math.min(currentSlide, slides.length - 1);
  const slide = slides[safeIndex];
  if (!slide) return null;
  const Icon = slide.icon;

  return (
    <div className="rounded-xl overflow-hidden shadow-2xl border border-slate-800 bg-slate-950">
      {/* Slide header bar */}
      <div className="bg-slate-900 px-5 py-3 flex items-center gap-3 border-b border-slate-800">
        <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center">
          <Icon className="w-4 h-4 text-primary" />
        </div>
        <div className="flex-1">
          <p className="text-xs font-semibold text-white">
            Step {slide.step} of {slides.length}: {slide.title}
          </p>
          <p className="text-[11px] text-slate-400">{slide.subtitle}</p>
        </div>
        <div className="flex gap-1">
          {slides.map((s, i) => (
            <button
              key={i}
              onClick={() => {
                setCurrentSlide(i);
                progressRef.current = (i / slides.length) * 100;
                setProgress(progressRef.current);
              }}
              className={`w-2 h-2 rounded-full transition-all ${
                i === currentSlide ? "bg-primary scale-125" : i < currentSlide ? "bg-primary/40" : "bg-slate-600"
              }`}
              title={`Step ${s.step}: ${s.title}`}
            />
          ))}
        </div>
      </div>

      {/* Slide content area */}
      <div className="p-5 bg-gradient-to-b from-slate-100 to-slate-50 min-h-[380px] relative">
        {!isPlaying && (
          <button
            onClick={() => setIsPlaying(true)}
            className="absolute inset-0 z-10 flex items-center justify-center bg-black/5 hover:bg-black/10 transition-colors cursor-pointer"
          >
            <div className="w-16 h-16 rounded-full bg-black/70 backdrop-blur-sm flex items-center justify-center shadow-xl hover:bg-black/80 transition-colors">
              <Play className="w-7 h-7 text-white ml-1" />
            </div>
          </button>
        )}
        {slide.content}
      </div>

      {/* Video control bar */}
      <div className="bg-gradient-to-t from-slate-950 to-slate-900 px-2 pt-0 pb-2">
        <div
          className="group h-5 flex items-center cursor-pointer px-2"
          onClick={handleProgressClick}
        >
          <div className="w-full h-1 group-hover:h-1.5 bg-slate-700 rounded-full relative transition-all">
            {slides.map((_, i) => {
              const pos = ((i + 1) / slides.length) * 100;
              if (i === slides.length - 1) return null;
              return (
                <div
                  key={i}
                  className="absolute top-0 bottom-0 w-px bg-slate-600"
                  style={{ left: `${pos}%` }}
                />
              );
            })}
            <div
              className="absolute top-0 left-0 h-full bg-red-600 rounded-full transition-none"
              style={{ width: `${progress}%` }}
            />
            <div
              className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-red-600 opacity-0 group-hover:opacity-100 transition-opacity shadow-md"
              style={{ left: `${progress}%`, marginLeft: "-6px" }}
            />
          </div>
        </div>

        <div className="flex items-center gap-1 px-1">
          <button
            onClick={() => setIsPlaying(!isPlaying)}
            className="p-1.5 text-white hover:text-white/80 transition-colors"
          >
            {isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
          </button>

          <button
            onClick={() => { prevSlide(); setIsPlaying(false); }}
            className="p-1.5 text-white/70 hover:text-white transition-colors"
          >
            <SkipBack className="w-4 h-4" />
          </button>

          <button
            onClick={() => { nextSlide(); setIsPlaying(false); }}
            className="p-1.5 text-white/70 hover:text-white transition-colors"
          >
            <SkipForward className="w-4 h-4" />
          </button>

          <button className="p-1.5 text-white/70 hover:text-white transition-colors">
            <Volume2 className="w-4 h-4" />
          </button>

          <span className="text-[11px] text-slate-400 font-mono ml-1">
            {formatTime(elapsedSeconds)} / {formatTime(totalSeconds)}
          </span>

          <div className="flex-1" />

          <span className="text-[10px] text-slate-500 mr-2">
            Terraform Walkthrough
          </span>

          <button className="p-1.5 text-white/70 hover:text-white transition-colors">
            <Maximize2 className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
