import { useState, useEffect, useCallback, useRef } from "react";
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Maximize2,
  Volume2,
  Package,
  FileText,
  Loader2,
  Check,
  GitBranch,
  Shield,
  Home,
  RefreshCw,
  Search,
  ChevronDown,
  Wrench,
  CheckCircle2,
  AlertTriangle,
  XCircle,
} from "lucide-react";

interface Slide {
  step: number;
  title: string;
  subtitle: string;
  icon: React.ElementType;
  content: React.ReactNode;
}

/* ─────────── Step Indicator (matches real Docker 6-step flow) ─────────── */
const dockerSteps = [
  { number: 1, title: "Repository" },
  { number: 2, title: "Requirements" },
  { number: 3, title: "Generate" },
  { number: 4, title: "Review" },
  { number: 5, title: "Activities" },
  { number: 6, title: "Commit" },
];

function MiniStepIndicator({ currentStep }: { currentStep: number }) {
  return (
    <div className="flex items-center justify-center gap-0 mb-3">
      {dockerSteps.map((step, i) => (
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
          {i < dockerSteps.length - 1 && (
            <div className={`w-6 h-px mt-[-10px] ${step.number < currentStep ? "bg-gradient-to-r from-blue-500 to-green-500" : "bg-slate-200"}`} />
          )}
        </div>
      ))}
    </div>
  );
}

/* ─────────── Activity Button Bar ─────────── */
/* Docker ActivityPanel has Security Scan + Best Approach */
function ActivityButtonBar({ active }: { active: "scan" | "best" }) {
  const activities = [
    { id: "best", label: "Best Approach", icon: Wrench },
    { id: "scan", label: "Security Scan", icon: Shield },
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
   DOCKER FLOW:
   Step 1 — Repository: Provider → Repo list → Branch select → Run Analysis
   Step 2 — Requirements: Analysis Summary (languages, frameworks, entrypoint,
            dependencies, base image, challenges, dockerfile status)
   Step 3 — Generate: Loading spinner
   Step 4 — Review: Files generated count + CodeEditor
   Step 5 — Activities: ActivityPanel (Security Scan, Cost, Best Approach, Draw)
   Step 6 — Commit: Repo + files list + Commit button
   ══════════════════════════════════════════════════════════════════════ */

/* ─────────── Slide 1: Step 1 — Provider Selection ─────────── */
function SlideProviderSelection() {
  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between px-2">
        <div className="flex items-center gap-2">
          <Package className="w-4 h-4 text-primary" />
          <span className="text-xs font-bold text-slate-900">Docker Workflow</span>
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

      <MiniStepIndicator currentStep={1} />

      {/* Scope banner */}
      <div className="border border-dashed border-slate-300 bg-slate-50 rounded p-2 text-[9px] text-slate-600">
        <p className="font-semibold text-slate-900">Docker module scope</p>
        <p>This workflow only generates Dockerfiles (and related Docker artifacts). Repository selection,
          branch analysis, and automated Dockerfile creation are the only supported steps.</p>
      </div>

      {/* Provider Selection */}
      <div className="text-center">
        <p className="text-xs font-bold text-slate-900">Select Repository Provider</p>
        <p className="text-[9px] text-slate-500">Choose where to store your Dockerfile</p>
      </div>

      <div className="grid grid-cols-2 gap-3 max-w-xs mx-auto">
        <div className="border-2 border-primary rounded-lg p-3 text-center bg-primary/5">
          <FileText className="w-5 h-5 mx-auto mb-1 text-primary" />
          <p className="text-[10px] font-semibold text-primary">GitHub</p>
          <p className="text-[8px] text-slate-500">Store Dockerfile in GitHub</p>
        </div>
        <div className="border border-slate-200 rounded-lg p-3 text-center hover:bg-slate-50">
          <FileText className="w-5 h-5 mx-auto mb-1 text-blue-600" />
          <p className="text-[10px] font-semibold text-blue-600">Azure DevOps</p>
          <p className="text-[8px] text-slate-500">Store Dockerfile in Azure DevOps</p>
        </div>
      </div>
    </div>
  );
}

/* ─────────── Slide 2: Step 1 — Repo + Branch + Run Analysis ─────────── */
function SlideRepoBranchAnalysis() {
  return (
    <div className="space-y-2.5">
      <MiniStepIndicator currentStep={1} />

      <div className="mb-2">
        <p className="text-xs font-bold text-slate-900">Select Repository</p>
        <p className="text-[9px] text-slate-500">
          Select an existing repository or create a new one from GitHub. Once the branch is selected, the repository scan runs automatically.
        </p>
      </div>

      <div className="grid grid-cols-[1fr_auto] gap-3">
        {/* Left: Repo list + selected + branch */}
        <div className="space-y-2">
          {/* Repository selected card */}
          <div className="border border-slate-200 rounded-lg bg-white p-2">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[8px] text-slate-400">Repository selected</p>
                <p className="text-[10px] font-semibold text-slate-900">my-nodejs-app</p>
              </div>
              <div className="px-2 py-0.5 text-[8px] text-slate-500 rounded border border-slate-200">Change</div>
            </div>
            <p className="text-[7px] text-slate-400 mt-1">The branch dropdown below lets you pick exactly which branch the AI should analyze.</p>
          </div>

          {/* Branch selector */}
          <div className="border border-slate-200 rounded-lg bg-white p-2.5 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-[9px] font-semibold text-slate-900">Branch</p>
            </div>
            <div className="flex items-center justify-between border border-slate-200 rounded px-2 py-1.5 bg-white">
              <span className="text-[9px] text-slate-700">main</span>
              <ChevronDown className="w-3 h-3 text-slate-400" />
            </div>
            <p className="text-[7px] text-slate-400">Branch selection is required to start the AI analysis.</p>
            <div className="w-full py-1.5 rounded-md bg-primary text-white text-[9px] font-medium text-center">
              Run Analysis
            </div>
          </div>
        </div>

        {/* Right: CreateRepoForm */}
        <div className="border border-slate-200 rounded-lg bg-white p-2 w-[140px]">
          <p className="text-[9px] font-semibold text-slate-900 mb-1.5">Create New Repository</p>
          <div className="space-y-1.5">
            <div className="h-5 bg-slate-100 rounded px-2 flex items-center text-[7px] text-slate-400">Repository name</div>
            <div className="h-7 bg-slate-100 rounded px-2 flex items-start pt-1 text-[7px] text-slate-400">Description</div>
            <div className="px-2 py-1 rounded bg-primary text-white text-[7px] font-medium text-center">Create</div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─────────── Slide 3: Step 2 — Analysis Summary (Requirements) ─────────── */
function SlideAnalysisSummary() {
  return (
    <div className="space-y-2">
      <MiniStepIndicator currentStep={2} />

      {/* Analysis Summary Card — matches real rounded-3xl */}
      <div className="rounded-2xl border border-slate-200 bg-white/90 p-3 shadow-lg">
        <div className="flex items-end justify-between mb-2">
          <div>
            <p className="text-[8px] uppercase tracking-[0.5em] text-slate-400">Analysis Summary</p>
            <p className="text-sm font-semibold text-slate-900 mt-1">my-nodejs-app</p>
            <p className="text-[8px] text-slate-500">GITHUB · Branch: main</p>
          </div>
          <div className="text-right text-[8px] text-slate-500">
            <p>Files inspected: <span className="font-semibold text-slate-900">12</span></p>
            <p>Analysis status: <span className="font-semibold text-green-600">Complete</span></p>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {[
            { label: "Languages", value: "TypeScript, JavaScript" },
            { label: "Frameworks", value: "Express, React" },
            { label: "Entrypoint", value: "npm start" },
          ].map((item) => (
            <div key={item.label} className="rounded-xl border border-slate-200 bg-slate-50 p-2">
              <p className="text-[7px] uppercase tracking-[0.4em] text-slate-400">{item.label}</p>
              <p className="text-[9px] font-semibold text-slate-900 mt-1">{item.value}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Dependencies + Base Image + Challenges */}
      <div className="grid grid-cols-[2fr_1fr] gap-2">
        <div className="border border-slate-200 rounded-lg bg-white p-2">
          <div className="flex items-center justify-between">
            <p className="text-[7px] uppercase tracking-[0.4em] text-slate-400">Dependencies</p>
            <span className="text-[7px] text-slate-400">3 detected</span>
          </div>
          <ul className="space-y-0.5 text-[8px] text-slate-700 mt-1">
            <li>1. package.json: express, react, typescript</li>
            <li>2. package-lock.json: 847 entries</li>
            <li>3. tsconfig.json: compiler config</li>
          </ul>
        </div>
        <div className="space-y-1.5">
          <div className="border border-slate-200 rounded-lg bg-white p-2">
            <p className="text-[7px] uppercase tracking-[0.4em] text-slate-400">Recommended base image</p>
            <p className="text-[9px] font-semibold text-slate-900 mt-0.5">node:20-alpine</p>
            <p className="text-[7px] font-semibold text-slate-900 mt-1">Build & runtime guide</p>
            <ul className="text-[7px] text-slate-600 space-y-0.5 mt-0.5">
              <li>Install Node deps (npm ci)</li>
              <li>Copy source & build</li>
              <li>Set CMD to npm start</li>
            </ul>
          </div>
          <div className="border border-slate-200 rounded-lg bg-white p-2">
            <p className="text-[7px] uppercase tracking-[0.4em] text-slate-400">Challenges</p>
            <p className="text-[7px] text-slate-700 mt-0.5">No major challenges detected.</p>
          </div>
        </div>
      </div>

      {/* Dockerfile status + Next button */}
      <div className="flex items-center justify-between border border-slate-200 rounded-lg bg-white p-2">
        <div>
          <p className="text-[7px] uppercase tracking-[0.4em] text-slate-400">Dockerfile status</p>
          <p className="text-[9px] font-semibold text-slate-900">No Dockerfile detected</p>
        </div>
        <p className="text-[7px] text-slate-400">AI will generate from scratch</p>
        <div className="px-3 py-1.5 rounded-md bg-primary text-white text-[9px] font-medium">Next → Generate</div>
      </div>
    </div>
  );
}

/* ─────────── Slide 4: Step 3 — Generating ─────────── */
function SlideGenerating() {
  return (
    <div className="space-y-3">
      <MiniStepIndicator currentStep={3} />

      <div className="rounded-2xl border-dashed border-slate-300 bg-white/80 p-8 text-center shadow-lg">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
          <p className="text-sm font-semibold text-slate-900">Generating Dockerfile...</p>
          <p className="text-[10px] text-slate-500 max-w-xs">
            The AI is building the optimized Dockerfile, .dockerignore, and supporting recommendations.
            This usually completes in a few seconds.
          </p>
        </div>
      </div>
    </div>
  );
}

/* ─────────── Slide 5: Step 4 — Review & Edit ─────────── */
function SlideReviewEdit() {
  return (
    <div className="space-y-2.5">
      <MiniStepIndicator currentStep={4} />

      <div className="text-center">
        <p className="text-xs font-bold text-slate-900">Generated Dockerfile</p>
        <p className="text-[9px] text-slate-500">Review and edit the AI-generated artifacts before scanning or committing</p>
      </div>

      {/* Files summary — matches real rounded-3xl card */}
      <div className="rounded-2xl border border-slate-200 bg-white/90 p-3 shadow-lg">
        <div className="flex items-end justify-between mb-2">
          <div>
            <p className="text-[8px] uppercase tracking-[0.5em] text-slate-400">Files generated</p>
            <p className="text-2xl font-semibold text-primary">3</p>
          </div>
          <p className="text-[8px] text-slate-500">Auto-generated from the repository scan</p>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {[
            { name: "Dockerfile", lines: 42, chars: 1280 },
            { name: ".dockerignore", lines: 15, chars: 320 },
            { name: "docker-compose.yml", lines: 28, chars: 680 },
          ].map((f) => (
            <div key={f.name} className="rounded-xl border border-slate-200 bg-slate-50 p-2">
              <p className="text-[9px] font-semibold text-slate-900">{f.name}</p>
              <p className="text-[7px] uppercase tracking-[0.5em] text-slate-400 mt-0.5">Artifacts</p>
              <p className="text-[7px] text-slate-500 mt-0.5">{f.lines} lines · {f.chars} chars</p>
            </div>
          ))}
        </div>
      </div>

      {/* Code editor — matches real CodeEditor */}
      <div className="rounded-2xl border border-slate-200 bg-slate-900 overflow-hidden shadow-lg">
        <div className="flex gap-0 border-b border-slate-700">
          <div className="px-3 py-1.5 bg-slate-800 text-[9px] text-white font-medium border-r border-slate-700">Dockerfile</div>
          <div className="px-3 py-1.5 text-[9px] text-slate-400">.dockerignore</div>
          <div className="px-3 py-1.5 text-[9px] text-slate-400">docker-compose.yml</div>
        </div>
        <div className="p-3 font-mono text-[8px] leading-relaxed text-green-400 h-[80px] overflow-hidden">
          <p><span className="text-blue-400">FROM</span> node:20-alpine <span className="text-blue-400">AS</span> builder</p>
          <p><span className="text-blue-400">WORKDIR</span> /app</p>
          <p><span className="text-blue-400">COPY</span> package*.json ./</p>
          <p><span className="text-blue-400">RUN</span> npm ci --only=production</p>
          <p><span className="text-blue-400">COPY</span> . .</p>
          <p><span className="text-blue-400">RUN</span> npm run build</p>
          <p><span className="text-blue-400">FROM</span> node:20-alpine</p>
          <p><span className="text-blue-400">EXPOSE</span> 3000</p>
        </div>
      </div>

      <div className="flex gap-2 justify-center">
        <div className="px-3 py-1.5 rounded-md border border-slate-200 text-[9px] text-slate-600 font-medium">← Back</div>
        <div className="px-3 py-1.5 rounded-md bg-primary text-white text-[9px] font-medium">Continue to Scan →</div>
      </div>
    </div>
  );
}

/* ─────────── Slide 6: Step 5 — Activities: Security Scan ─────────── */
function SlideSecurityScan() {
  return (
    <div className="space-y-2.5">
      <MiniStepIndicator currentStep={5} />

      <div className="text-center">
        <h3 className="text-sm font-bold text-slate-900">Activities</h3>
        <p className="text-[10px] text-slate-500">Run security scans and other activities on your Dockerfile</p>
      </div>

      <ActivityButtonBar active="scan" />

      {/* Pass/fail summary */}
      <div className="flex items-center gap-4 p-3 rounded-xl bg-white border border-slate-200 shadow-sm">
        <div className="relative w-14 h-14">
          <svg className="w-14 h-14 -rotate-90" viewBox="0 0 36 36">
            <circle cx="18" cy="18" r="15" fill="none" stroke="#e2e8f0" strokeWidth="3" />
            <circle cx="18" cy="18" r="15" fill="none" stroke="#22c55e" strokeWidth="3" strokeDasharray="75 25" strokeLinecap="round" />
          </svg>
          <span className="absolute inset-0 flex items-center justify-center text-[11px] font-bold text-green-600">75%</span>
        </div>
        <div className="flex-1 space-y-1">
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-full bg-green-500" />
            <span className="text-[10px] font-medium text-slate-700">Passed: 9</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-full bg-red-500" />
            <span className="text-[10px] font-medium text-slate-700">Failed: 3</span>
          </div>
        </div>
      </div>

      {/* Failed checks */}
      <div className="rounded-lg border border-slate-200 bg-white p-2">
        <p className="text-[9px] font-semibold text-slate-700 mb-1">Dockerfile — 3 failed checks</p>
        <div className="space-y-1">
          {[
            { id: "CKV_DOCKER_2", desc: "Ensure Dockerfile HEALTHCHECK is added" },
            { id: "CKV_DOCKER_3", desc: "Ensure no COPY with chown flag" },
            { id: "CKV_DOCKER_7", desc: "Ensure the base image uses a non-root user" },
          ].map((c) => (
            <div key={c.id} className="flex items-center gap-2 p-1.5 rounded bg-red-50 border border-red-200">
              <input type="checkbox" className="w-3 h-3" readOnly />
              <span className="text-[8px] font-mono text-red-700">{c.id}</span>
              <span className="text-[8px] text-slate-600 flex-1">{c.desc}</span>
            </div>
          ))}
        </div>
        <div className="mt-2 flex gap-2">
          <div className="px-2 py-1 rounded bg-slate-100 text-[8px] text-slate-600">Select All</div>
          <div className="px-2 py-1 rounded bg-primary text-white text-[8px] font-medium">Fix Selected</div>
        </div>
      </div>

      <div className="flex gap-2 justify-center">
        <div className="px-3 py-1.5 rounded-md border border-slate-200 text-[9px] text-slate-600">← Back</div>
        <div className="px-3 py-1.5 rounded-md bg-primary text-white text-[9px] font-medium">Continue to Commit →</div>
      </div>
      <p className="text-[8px] text-slate-400 text-center">Please run a security scan before committing</p>
    </div>
  );
}

/* ─────────── Slide 7: Step 5 — Activities: Best Approach ─────────── */
function SlideBestApproach() {
  return (
    <div className="space-y-2.5">
      <MiniStepIndicator currentStep={5} />

      <div className="text-center">
        <h3 className="text-sm font-bold text-slate-900">Activities — Best Approach</h3>
        <p className="text-[10px] text-slate-500">Validate Docker best practices: official images, version pinning, security</p>
      </div>

      <ActivityButtonBar active="best" />

      {/* Summary card */}
      <div className="rounded-xl border-2 border-amber-300 bg-amber-50 p-3 flex items-center gap-3">
        <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0" />
        <div>
          <p className="text-[10px] font-semibold text-amber-800">2 warnings found</p>
          <p className="text-[9px] text-amber-700">7 passed · 2 warnings · 0 failed · 9 checks</p>
        </div>
      </div>

      {/* Findings */}
      <div className="space-y-1.5">
        <div className="rounded-lg border border-green-200 bg-green-50 p-2 border-l-4 border-l-green-400">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-3 h-3 text-green-600 shrink-0" />
            <span className="text-[8px] px-1 py-0.5 rounded bg-green-100 text-green-700 font-bold">PASSED</span>
            <span className="text-[8px] font-semibold text-slate-900">Official base image</span>
          </div>
          <p className="text-[7px] text-slate-600 mt-0.5 ml-5">Image "node:20.11-alpine" is from an official publisher.</p>
        </div>
        <div className="rounded-lg border border-green-200 bg-green-50 p-2 border-l-4 border-l-green-400">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-3 h-3 text-green-600 shrink-0" />
            <span className="text-[8px] px-1 py-0.5 rounded bg-green-100 text-green-700 font-bold">PASSED</span>
            <span className="text-[8px] font-semibold text-slate-900">Version pinned</span>
          </div>
          <p className="text-[7px] text-slate-600 mt-0.5 ml-5">Image has a pinned version tag (not :latest).</p>
        </div>
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-2 border-l-4 border-l-amber-400">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-3 h-3 text-amber-600 shrink-0" />
            <span className="text-[8px] px-1 py-0.5 rounded bg-amber-100 text-amber-700 font-bold">WARNING</span>
            <span className="text-[8px] font-semibold text-slate-900">Single-stage build</span>
          </div>
          <p className="text-[7px] text-slate-600 mt-0.5 ml-5">Consider using multi-stage builds to separate build deps.</p>
          <div className="mt-1 ml-5 rounded bg-white/60 border border-slate-200 p-1">
            <p className="text-[7px] text-slate-700 font-mono">Add a builder stage and copy only required artifacts.</p>
          </div>
        </div>
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-2 border-l-4 border-l-amber-400">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-3 h-3 text-amber-600 shrink-0" />
            <span className="text-[8px] px-1 py-0.5 rounded bg-amber-100 text-amber-700 font-bold">WARNING</span>
            <span className="text-[8px] font-semibold text-slate-900">Missing HEALTHCHECK</span>
          </div>
          <p className="text-[7px] text-slate-600 mt-0.5 ml-5">No HEALTHCHECK instruction found.</p>
        </div>
      </div>
    </div>
  );
}

/* ─────────── Slide 8: Step 6 — Commit ─────────── */
function SlideCommit() {
  return (
    <div className="space-y-3">
      <MiniStepIndicator currentStep={6} />

      <div className="text-center">
        <p className="text-xs font-bold text-slate-900">Commit to Repository</p>
        <p className="text-[9px] text-slate-500">Commit your Dockerfile to my-nodejs-app</p>
      </div>

      <div className="max-w-xs mx-auto bg-slate-50 rounded-lg p-3 space-y-3">
        <div>
          <p className="text-[9px] font-semibold text-slate-900 mb-0.5">Repository:</p>
          <p className="text-[9px] text-slate-500">my-nodejs-app</p>
        </div>
        <div>
          <p className="text-[9px] font-semibold text-slate-900 mb-0.5">Files to commit:</p>
          <ul className="text-[9px] text-slate-500 list-disc list-inside">
            <li>Dockerfile</li>
            <li>.dockerignore</li>
            <li>docker-compose.yml</li>
          </ul>
        </div>
      </div>

      <div className="flex gap-3 justify-center">
        <div className="px-4 py-2 rounded-md border border-slate-200 text-[11px] text-slate-600 font-medium">← Back</div>
        <div className="px-4 py-2 rounded-md bg-primary text-white text-[11px] font-medium flex items-center gap-1.5">
          <FileText className="w-3 h-3" /> Commit to Repository
        </div>
      </div>

      {/* Success state */}
      <div className="max-w-xs mx-auto flex flex-col items-center gap-2 p-4 border border-green-200 rounded-lg bg-green-50">
        <div className="flex items-center gap-2 text-green-600">
          <div className="w-5 h-5 rounded-full bg-green-100 flex items-center justify-center">
            <Check className="w-3 h-3 text-green-600" />
          </div>
          <h3 className="text-[11px] font-semibold">Successfully Committed!</h3>
        </div>
        <p className="text-[9px] text-slate-500 text-center">Dockerfile committed to my-nodejs-app</p>
      </div>
    </div>
  );
}

const slides: Slide[] = [
  { step: 1, title: "Select Provider", subtitle: "Step 1: Choose GitHub or Azure DevOps", icon: Package, content: <SlideProviderSelection /> },
  { step: 2, title: "Repo & Branch", subtitle: "Step 1: Select repo, pick branch, run analysis", icon: GitBranch, content: <SlideRepoBranchAnalysis /> },
  { step: 3, title: "Analysis Summary", subtitle: "Step 2: Languages, frameworks, dependencies, base image", icon: Search, content: <SlideAnalysisSummary /> },
  { step: 4, title: "Generate", subtitle: "Step 3: AI generates Dockerfile from repo analysis", icon: Loader2, content: <SlideGenerating /> },
  { step: 5, title: "Review & Edit", subtitle: "Step 4: Review files in CodeEditor", icon: FileText, content: <SlideReviewEdit /> },
  { step: 6, title: "Best Approach", subtitle: "Step 5: Official images, version pinning, security", icon: Wrench, content: <SlideBestApproach /> },
  { step: 7, title: "Security Scan", subtitle: "Step 5: Checkov scan with auto-fix", icon: Shield, content: <SlideSecurityScan /> },
  { step: 8, title: "Commit & Push", subtitle: "Step 6: Commit Dockerfile to repository", icon: Package, content: <SlideCommit /> },
];

const SLIDE_DURATION = 5000;

function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function DockerWalkthrough() {
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
          <span className="text-[10px] text-slate-500 mr-2">Docker Walkthrough</span>
          <button className="p-1.5 text-white/70 hover:text-white transition-colors"><Maximize2 className="w-4 h-4" /></button>
        </div>
      </div>
    </div>
  );
}
