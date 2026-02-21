import { useState, useEffect, useCallback, useRef } from "react";
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Maximize2,
  Volume2,
  Package,
  FileCode,
  Loader2,
  Check,
  GitBranch,
  Shield,
  Home,
  RefreshCw,
  Cloud,
  CodeIcon,
  Wrench,
  CheckCircle2,
  AlertTriangle,
  FileText,
  Upload,
} from "lucide-react";

interface Slide {
  step: number;
  title: string;
  subtitle: string;
  icon: React.ElementType;
  content: React.ReactNode;
}

/* ─────────── Step Indicator (matches real Kubernetes 7-step flow) ─────────── */
const kubernetesSteps = [
  { number: 1, title: "Workflow" },
  { number: 2, title: "Repository" },
  { number: 3, title: "Describe" },
  { number: 4, title: "Generate" },
  { number: 5, title: "Review" },
  { number: 6, title: "Activities" },
  { number: 7, title: "Commit" },
];

function MiniStepIndicator({ currentStep }: { currentStep: number }) {
  return (
    <div className="flex items-center justify-center gap-0 mb-3">
      {kubernetesSteps.map((step, i) => (
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
          {i < kubernetesSteps.length - 1 && (
            <div className={`w-6 h-px mt-[-10px] ${step.number < currentStep ? "bg-gradient-to-r from-blue-500 to-green-500" : "bg-slate-200"}`} />
          )}
        </div>
      ))}
    </div>
  );
}

/* ─────────── Activity Button Bar ─────────── */
function ActivityButtonBar({ active }: { active: "scan" | "validate" | "best" }) {
  const activities = [
    { id: "scan", label: "Security Scan", icon: Shield },
    { id: "validate", label: "Validate", icon: CheckCircle2 },
    { id: "best", label: "Best Practices", icon: Wrench },
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
   KUBERNETES FLOW:
   Step 1 — Workflow: Manifest Generation vs Helm Chart Validation
   Step 2 — Repository: Provider → Repo list → Create/Select
   Step 3 — Describe: Natural language workload description (Manifest) or Upload Chart (Helm)
   Step 4 — Generate: AI generates manifests with best practices
   Step 5 — Review: Files generated + CodeEditor
   Step 6 — Activities: Security Scan, Validate, Best Practices, Draw
   Step 7 — Commit: Repo + files list + Commit button
   ══════════════════════════════════════════════════════════════════════ */

/* ─────────── Slide 1: Step 1 — Workflow Selection ─────────── */
function SlideWorkflowSelection() {
  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between px-2">
        <div className="flex items-center gap-2">
          <Package className="w-4 h-4 text-primary" />
          <span className="text-xs font-bold text-slate-900">Kubernetes Workflow</span>
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

      {/* Intro message */}
      <div className="border border-blue-200 bg-blue-50 rounded p-2 text-[9px] text-blue-700">
        <p className="font-semibold">Welcome to Kubernetes Workflow!</p>
        <p>Choose a workflow type to get started: Manifest Generation or Helm Chart Validation.</p>
      </div>

      {/* Workflow Selection */}
      <div className="text-center">
        <p className="text-xs font-bold text-slate-900">Select Workflow Type</p>
        <p className="text-[9px] text-slate-500">Choose how you want to work with Kubernetes</p>
      </div>

      <div className="grid grid-cols-2 gap-3 max-w-md mx-auto">
        <div className="border-2 border-primary rounded-lg p-3 text-center bg-primary/5">
          <FileCode className="w-5 h-5 mx-auto mb-1 text-primary" />
          <p className="text-[10px] font-semibold text-primary">Manifest Generation</p>
          <p className="text-[8px] text-slate-500">Generate Kubernetes manifests from natural language descriptions</p>
        </div>
        <div className="border border-slate-200 rounded-lg p-3 text-center hover:bg-slate-50">
          <Package className="w-5 h-5 mx-auto mb-1 text-blue-600" />
          <p className="text-[10px] font-semibold text-blue-600">Helm Chart Validation</p>
          <p className="text-[8px] text-slate-500">Validate and lint Helm charts with best practice checks</p>
        </div>
      </div>
    </div>
  );
}

/* ─────────── Slide 2: Step 2 — Provider Selection ─────────── */
function SlideProviderSelection() {
  return (
    <div className="space-y-3">
      <MiniStepIndicator currentStep={2} />

      <div className="text-center">
        <p className="text-xs font-bold text-slate-900">Select Repository Provider</p>
        <p className="text-[9px] text-slate-500">Choose where to store your Kubernetes configurations</p>
      </div>

      <div className="grid grid-cols-2 gap-3 max-w-xs mx-auto">
        <div className="border-2 border-primary rounded-lg p-3 text-center bg-primary/5">
          <CodeIcon className="w-5 h-5 mx-auto mb-1 text-primary" />
          <p className="text-[10px] font-semibold text-primary">GitHub</p>
          <p className="text-[8px] text-slate-500">Use GitHub repositories for your Kubernetes configurations</p>
        </div>
        <div className="border border-slate-200 rounded-lg p-3 text-center hover:bg-slate-50">
          <Cloud className="w-5 h-5 mx-auto mb-1 text-blue-600" />
          <p className="text-[10px] font-semibold text-blue-600">Azure DevOps</p>
          <p className="text-[8px] text-slate-500">Use Azure DevOps repositories</p>
        </div>
      </div>
    </div>
  );
}

/* ─────────── Slide 3: Step 2 — Repository Selection ─────────── */
function SlideRepoSelection() {
  return (
    <div className="space-y-2.5">
      <MiniStepIndicator currentStep={2} />

      <div className="mb-2">
        <p className="text-xs font-bold text-slate-900">Select Repository</p>
        <p className="text-[9px] text-slate-500">
          Choose an existing repository or create a new one
        </p>
      </div>

      <div className="grid grid-cols-[1fr_auto] gap-3">
        {/* Left: Repo list */}
        <div className="space-y-2">
          <div className="border border-slate-200 rounded-lg bg-white p-2">
            <div className="flex items-center justify-between mb-1.5">
              <p className="text-[9px] font-semibold text-slate-900">Repositories</p>
              <span className="text-[7px] text-slate-400">5 found</span>
            </div>
            <div className="space-y-1">
              {["k8s-production", "microservices-k8s", "my-app-k8s"].map((repo, i) => (
                <div
                  key={repo}
                  className={`p-1.5 rounded border ${
                    i === 0 ? "border-primary bg-primary/5" : "border-slate-200 bg-white"
                  }`}
                >
                  <p className="text-[9px] font-medium text-slate-900">{repo}</p>
                </div>
              ))}
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

/* ─────────── Slide 4: Step 3 — Describe Workload ─────────── */
function SlideDescribeWorkload() {
  return (
    <div className="space-y-3">
      <MiniStepIndicator currentStep={3} />

      <div className="text-center">
        <p className="text-xs font-bold text-slate-900">Describe Your Kubernetes Workload</p>
        <p className="text-[9px] text-slate-500">Describe what you want to deploy in natural language</p>
      </div>

      {/* Chat Input */}
      <div className="max-w-md mx-auto">
        <div className="border border-slate-200 rounded-lg bg-white p-2">
          <div className="h-20 bg-slate-50 rounded px-2 py-1.5 text-[8px] text-slate-400 mb-2">
            Deploy a Node.js app with 3 replicas, exposed via LoadBalancer on port 3000,
            with environment variables from ConfigMap, CPU/memory limits, health checks,
            and security context with non-root user
          </div>
          <div className="flex justify-end">
            <div className="px-3 py-1 rounded bg-primary text-white text-[8px] font-medium">
              Generate Manifests
            </div>
          </div>
        </div>
      </div>

      <div className="border border-dashed border-amber-300 bg-amber-50 rounded p-2 text-[9px] text-amber-700">
        <p className="font-semibold">AI Generation with Best Practices</p>
        <p className="text-[8px]">The AI will generate manifests with resource limits, probes, security context, and production-ready configurations.</p>
      </div>
    </div>
  );
}

/* ─────────── Slide 5: Step 4 — Generating ─────────── */
function SlideGenerating() {
  return (
    <div className="space-y-3">
      <MiniStepIndicator currentStep={4} />

      <div className="rounded-2xl border-dashed border-slate-300 bg-white/80 p-8 text-center shadow-lg">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
          <p className="text-sm font-semibold text-slate-900">Generating Kubernetes Manifests...</p>
          <p className="text-[10px] text-slate-500 max-w-xs">
            The AI is generating optimized Kubernetes manifests with deployment, service,
            configmap, and best practice configurations.
          </p>
        </div>
      </div>
    </div>
  );
}

/* ─────────── Slide 6: Step 5 — Review Generated Files ─────────── */
function SlideReviewFiles() {
  return (
    <div className="space-y-2.5">
      <MiniStepIndicator currentStep={5} />

      <div className="text-center">
        <p className="text-xs font-bold text-slate-900">Review Generated Manifests</p>
        <p className="text-[9px] text-slate-500">Review and edit the generated Kubernetes manifests</p>
      </div>

      {/* Files summary */}
      <div className="rounded-2xl border border-slate-200 bg-white/90 p-3 shadow-lg">
        <div className="flex items-end justify-between mb-2">
          <div>
            <p className="text-[8px] uppercase tracking-[0.5em] text-slate-400">Manifests generated</p>
            <p className="text-2xl font-semibold text-primary">4</p>
          </div>
          <p className="text-[8px] text-slate-500">Deployment, Service, ConfigMap, HPA</p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {[
            { name: "deployment.yaml", type: "Deployment", replicas: 3 },
            { name: "service.yaml", type: "LoadBalancer", port: 3000 },
            { name: "configmap.yaml", type: "ConfigMap", keys: 5 },
            { name: "hpa.yaml", type: "HPA", min: 3, max: 10 },
          ].map((f) => (
            <div key={f.name} className="rounded-xl border border-slate-200 bg-slate-50 p-2">
              <p className="text-[9px] font-semibold text-slate-900">{f.name}</p>
              <p className="text-[7px] uppercase tracking-[0.5em] text-slate-400 mt-0.5">{f.type}</p>
              <p className="text-[7px] text-slate-500 mt-0.5">
                {f.type === "Deployment" && `${f.replicas} replicas`}
                {f.type === "LoadBalancer" && `Port ${f.port}`}
                {f.type === "ConfigMap" && `${f.keys} keys`}
                {f.type === "HPA" && `${f.min}-${f.max} pods`}
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* Code editor preview */}
      <div className="rounded-2xl border border-slate-200 bg-slate-900 overflow-hidden shadow-lg">
        <div className="flex gap-0 border-b border-slate-700">
          <div className="px-3 py-1.5 bg-slate-800 text-[9px] text-white font-medium border-r border-slate-700">deployment.yaml</div>
          <div className="px-3 py-1.5 text-[9px] text-slate-400">service.yaml</div>
          <div className="px-3 py-1.5 text-[9px] text-slate-400">configmap.yaml</div>
        </div>
        <div className="p-3 font-mono text-[8px] leading-relaxed text-green-400 h-[80px] overflow-hidden">
          <p><span className="text-blue-400">apiVersion:</span> apps/v1</p>
          <p><span className="text-blue-400">kind:</span> Deployment</p>
          <p><span className="text-blue-400">metadata:</span></p>
          <p>  <span className="text-blue-400">name:</span> my-nodejs-app</p>
          <p><span className="text-blue-400">spec:</span></p>
          <p>  <span className="text-blue-400">replicas:</span> 3</p>
          <p>  <span className="text-blue-400">selector:</span></p>
          <p>    <span className="text-blue-400">matchLabels:</span></p>
        </div>
      </div>
    </div>
  );
}

/* ─────────── Slide 7: Step 6 — Security Scan ─────────── */
function SlideSecurityScan() {
  return (
    <div className="space-y-2.5">
      <MiniStepIndicator currentStep={6} />

      <div className="text-center">
        <h3 className="text-sm font-bold text-slate-900">Activities — Security Scan</h3>
        <p className="text-[10px] text-slate-500">Scan for security vulnerabilities and misconfigurations</p>
      </div>

      <ActivityButtonBar active="scan" />

      {/* Summary card */}
      <div className="rounded-xl border-2 border-green-300 bg-green-50 p-3 flex items-center gap-3">
        <CheckCircle2 className="w-5 h-5 text-green-600 shrink-0" />
        <div>
          <p className="text-[10px] font-semibold text-green-800">Scan complete — 2 issues found</p>
          <p className="text-[9px] text-green-700">10 passed · 2 warnings · 0 failed · 12 checks</p>
        </div>
      </div>

      {/* Issues */}
      <div className="space-y-1.5">
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-2 border-l-4 border-l-amber-400">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-3 h-3 text-amber-600 shrink-0" />
            <span className="text-[8px] px-1 py-0.5 rounded bg-amber-100 text-amber-700 font-bold">WARNING</span>
            <span className="text-[8px] font-semibold text-slate-900">No resource limits defined</span>
          </div>
          <p className="text-[7px] text-slate-600 mt-0.5 ml-5">Container should have CPU and memory limits for better resource management.</p>
          <div className="mt-1 ml-5 rounded bg-white/60 border border-slate-200 p-1">
            <p className="text-[7px] text-slate-700 font-mono">Add resources.limits.cpu and resources.limits.memory</p>
          </div>
        </div>
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-2 border-l-4 border-l-amber-400">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-3 h-3 text-amber-600 shrink-0" />
            <span className="text-[8px] px-1 py-0.5 rounded bg-amber-100 text-amber-700 font-bold">WARNING</span>
            <span className="text-[8px] font-semibold text-slate-900">Running as root user</span>
          </div>
          <p className="text-[7px] text-slate-600 mt-0.5 ml-5">Container should run as non-root user for security.</p>
        </div>
      </div>

      <div className="flex gap-2 justify-center">
        <div className="px-2 py-1 rounded bg-slate-100 text-[8px] text-slate-600">Select All</div>
        <div className="px-2 py-1 rounded bg-primary text-white text-[8px] font-medium">Fix Selected</div>
      </div>
    </div>
  );
}

/* ─────────── Slide 8: Step 6 — Best Practices Validation ─────────── */
function SlideBestPractices() {
  return (
    <div className="space-y-2.5">
      <MiniStepIndicator currentStep={6} />

      <div className="text-center">
        <h3 className="text-sm font-bold text-slate-900">Activities — Best Practices</h3>
        <p className="text-[10px] text-slate-500">Validate Kubernetes best practices and production readiness</p>
      </div>

      <ActivityButtonBar active="best" />

      {/* Findings */}
      <div className="space-y-1.5">
        <div className="rounded-lg border border-green-200 bg-green-50 p-2 border-l-4 border-l-green-400">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-3 h-3 text-green-600 shrink-0" />
            <span className="text-[8px] px-1 py-0.5 rounded bg-green-100 text-green-700 font-bold">PASSED</span>
            <span className="text-[8px] font-semibold text-slate-900">Liveness probe configured</span>
          </div>
          <p className="text-[7px] text-slate-600 mt-0.5 ml-5">Container has liveness probe for health monitoring.</p>
        </div>
        <div className="rounded-lg border border-green-200 bg-green-50 p-2 border-l-4 border-l-green-400">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-3 h-3 text-green-600 shrink-0" />
            <span className="text-[8px] px-1 py-0.5 rounded bg-green-100 text-green-700 font-bold">PASSED</span>
            <span className="text-[8px] font-semibold text-slate-900">Readiness probe configured</span>
          </div>
          <p className="text-[7px] text-slate-600 mt-0.5 ml-5">Container has readiness probe for traffic management.</p>
        </div>
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-2 border-l-4 border-l-amber-400">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-3 h-3 text-amber-600 shrink-0" />
            <span className="text-[8px] px-1 py-0.5 rounded bg-amber-100 text-amber-700 font-bold">WARNING</span>
            <span className="text-[8px] font-semibold text-slate-900">No HPA configured</span>
          </div>
          <p className="text-[7px] text-slate-600 mt-0.5 ml-5">Consider adding HorizontalPodAutoscaler for automatic scaling.</p>
        </div>
      </div>
    </div>
  );
}

/* ─────────── Slide 9: Step 7 — Commit ─────────── */
function SlideCommit() {
  return (
    <div className="space-y-3">
      <MiniStepIndicator currentStep={7} />

      <div className="text-center">
        <p className="text-xs font-bold text-slate-900">Commit & Push</p>
        <p className="text-[9px] text-slate-500">Review your files and commit them to the repository</p>
      </div>

      <div className="max-w-xs mx-auto bg-slate-50 rounded-lg p-3 space-y-3">
        <div>
          <p className="text-[9px] font-semibold text-slate-900 mb-0.5">Repository:</p>
          <p className="text-[9px] text-slate-500">k8s-production</p>
        </div>
        <div>
          <p className="text-[9px] font-semibold text-slate-900 mb-0.5">Files to commit:</p>
          <ul className="text-[9px] text-slate-500 list-disc list-inside">
            <li>deployment.yaml</li>
            <li>service.yaml</li>
            <li>configmap.yaml</li>
            <li>hpa.yaml</li>
          </ul>
        </div>
        <div>
          <p className="text-[9px] font-semibold text-slate-900 mb-0.5">Commit message:</p>
          <div className="h-8 bg-white rounded px-2 py-1 border border-slate-200 text-[8px] text-slate-600">
            Add Kubernetes manifests for Node.js app deployment
          </div>
        </div>
      </div>

      <div className="flex gap-3 justify-center">
        <div className="px-4 py-2 rounded-md border border-slate-200 text-[11px] text-slate-600 font-medium">← Back</div>
        <div className="px-4 py-2 rounded-md bg-primary text-white text-[11px] font-medium flex items-center gap-1.5">
          <FileCode className="w-3 h-3" /> Commit & Push
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
        <p className="text-[9px] text-slate-500 text-center">Kubernetes manifests committed to k8s-production</p>
      </div>
    </div>
  );
}

const slides: Slide[] = [
  { step: 1, title: "Workflow Selection", subtitle: "Choose: Manifest Generation or Helm Chart Validation", icon: Package, content: <SlideWorkflowSelection /> },
  { step: 2, title: "Provider Selection", subtitle: "Select GitHub or Azure DevOps", icon: Cloud, content: <SlideProviderSelection /> },
  { step: 3, title: "Repository", subtitle: "Select or create a repository", icon: GitBranch, content: <SlideRepoSelection /> },
  { step: 4, title: "Describe Workload", subtitle: "Natural language description of your Kubernetes workload", icon: FileText, content: <SlideDescribeWorkload /> },
  { step: 5, title: "Generate Manifests", subtitle: "AI generates production-ready Kubernetes manifests", icon: Loader2, content: <SlideGenerating /> },
  { step: 6, title: "Review Files", subtitle: "Review and edit generated manifests in CodeEditor", icon: FileCode, content: <SlideReviewFiles /> },
  { step: 7, title: "Security Scan", subtitle: "Scan for vulnerabilities and misconfigurations", icon: Shield, content: <SlideSecurityScan /> },
  { step: 8, title: "Best Practices", subtitle: "Validate Kubernetes best practices", icon: Wrench, content: <SlideBestPractices /> },
  { step: 9, title: "Commit & Push", subtitle: "Commit manifests to repository", icon: Package, content: <SlideCommit /> },
];

const SLIDE_DURATION = 5000;

function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function KubernetesWalkthrough() {
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
          <span className="text-[10px] text-slate-500 mr-2">Kubernetes Walkthrough</span>
          <button className="p-1.5 text-white/70 hover:text-white transition-colors"><Maximize2 className="w-4 h-4" /></button>
        </div>
      </div>
    </div>
  );
}
