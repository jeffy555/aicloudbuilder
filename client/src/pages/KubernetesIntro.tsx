import { useLocation } from "wouter";
import Header from "@/components/Header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  ArrowRight,
  Home,
  ShieldCheck,
  GitBranch,
  Zap,
  Lock,
  CheckCircle2,
  Package2,
  Layers,
  Wrench,
  FileCode2,
} from "lucide-react";
import KubernetesWalkthrough from "@/components/KubernetesWalkthrough";

const VALUE_PROPS = [
  {
    icon: Zap,
    color: "text-amber-500",
    bg: "bg-amber-50 border-amber-100",
    headline: "YAML in seconds, not hours",
    detail:
      "Describe your workload once in plain English — AI writes every Deployment, Service, Ingress, HPA, and ConfigMap simultaneously.",
  },
  {
    icon: Layers,
    color: "text-blue-500",
    bg: "bg-blue-50 border-blue-100",
    headline: "4 workflow types, one tool",
    detail:
      "Manifest generation, Kustomize overlays, Helm chart validation, and AI Helm generation — every K8s pattern covered.",
  },
  {
    icon: ShieldCheck,
    color: "text-emerald-500",
    bg: "bg-emerald-50 border-emerald-100",
    headline: "Security-scanned before it ever deploys",
    detail:
      "Checkov validates misconfigurations, RBAC gaps, and missing resource limits automatically — one-click AI fix for every failure.",
  },
  {
    icon: Wrench,
    color: "text-violet-500",
    bg: "bg-violet-50 border-violet-100",
    headline: "Best-practice baseline out of the box",
    detail:
      "Liveness probes, resource quotas, non-root containers, image version pins — enforced by AI, not hoped for.",
  },
  {
    icon: Package2,
    color: "text-rose-500",
    bg: "bg-rose-50 border-rose-100",
    headline: "AI Helm charts — generated, not just validated",
    detail:
      "Chart.yaml, values.yaml, templates, HPA, Ingress, and dev/prod overlays generated from a description in under 30 seconds.",
  },
  {
    icon: GitBranch,
    color: "text-indigo-500",
    bg: "bg-indigo-50 border-indigo-100",
    headline: "Commit directly to GitHub or Azure DevOps",
    detail:
      "Review, edit, scan, and push — all without leaving the platform. No copy-paste, no tab switching.",
  },
];

const WORKFLOW_STEPS = [
  { step: 1, label: "Workflow", detail: "Manifest / Kustomize / Helm" },
  { step: 2, label: "Provider", detail: "GitHub or Azure DevOps" },
  { step: 3, label: "Repository", detail: "Existing or new repo" },
  { step: 4, label: "Describe", detail: "Plain English workload intent" },
  { step: 5, label: "Generate", detail: "AI writes all manifests" },
  { step: 6, label: "Review", detail: "Edit in built-in code editor" },
  { step: 7, label: "Scan", detail: "Security + best-practices" },
  { step: 8, label: "Commit", detail: "Push to your branch" },
];

export default function KubernetesIntro() {
  const [, setLocation] = useLocation();

  return (
    <div className="min-h-screen bg-background">
      <Header />

      <main className="container mx-auto px-6 py-12">
        <div className="max-w-4xl mx-auto space-y-8">

          {/* ── Hero ── */}
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Badge variant="secondary" className="text-xs font-semibold tracking-wide uppercase">
                  Container Orchestration
                </Badge>
                <Badge className="text-xs font-semibold bg-blue-100 text-blue-700 hover:bg-blue-100">
                  Multi-Workflow
                </Badge>
              </div>
              <h1 className="text-4xl font-extrabold tracking-tight text-slate-900">
                From description to{" "}
                <span className="bg-gradient-to-r from-blue-600 to-cyan-500 bg-clip-text text-transparent">
                  production Kubernetes
                </span>
              </h1>
              <p className="text-lg text-muted-foreground max-w-2xl">
                Describe your workload. Get security-scanned, best-practice validated Kubernetes
                manifests — committed to your repo in one guided workflow.
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={() => setLocation("/")}>
              <Home className="w-4 h-4 mr-2" />
              Home
            </Button>
          </div>

          {/* ── Value Props Grid ── */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {VALUE_PROPS.map(({ icon: Icon, color, bg, headline, detail }) => (
              <div key={headline} className={`rounded-xl border p-4 space-y-2 ${bg}`}>
                <div className="flex items-center gap-2">
                  <Icon className={`w-5 h-5 ${color}`} />
                  <span className="text-sm font-semibold text-slate-800">{headline}</span>
                </div>
                <p className="text-xs text-slate-500 leading-relaxed">{detail}</p>
              </div>
            ))}
          </div>

          {/* ── Workflow Steps ── */}
          <Card className="border-slate-200">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <FileCode2 className="w-4 h-4 text-primary" />
                8-step guided workflow — from description to committed manifests
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {WORKFLOW_STEPS.map(({ step, label, detail }) => (
                  <div key={step} className="flex items-start gap-2.5">
                    <div className="mt-0.5 w-5 h-5 rounded-full bg-gradient-to-br from-blue-600 to-cyan-500 text-white text-[10px] font-bold flex items-center justify-center shrink-0">
                      {step}
                    </div>
                    <div>
                      <p className="text-xs font-semibold text-slate-700">{label}</p>
                      <p className="text-[11px] text-slate-400">{detail}</p>
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-4 pt-4 border-t border-slate-100 grid grid-cols-1 sm:grid-cols-3 gap-3">
                {[
                  { icon: Lock, text: "Helm charts linted immediately after generation" },
                  { icon: CheckCircle2, text: "Checkov security scan with one-click AI auto-fix" },
                  { icon: ShieldCheck, text: "Best-practice advisor validates every manifest" },
                ].map(({ icon: Icon, text }) => (
                  <div key={text} className="flex items-start gap-2 text-xs text-slate-500">
                    <Icon className="w-3.5 h-3.5 text-primary shrink-0 mt-0.5" />
                    <span>{text}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* ── Walkthrough ── */}
          <Card className="border-slate-200">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Zap className="w-4 h-4 text-amber-500" />
                Live workflow preview — see exactly what you'll get
              </CardTitle>
              <p className="text-sm text-muted-foreground">
                Each slide mirrors a real step. Auto-plays every 5 s or use the controls.
              </p>
            </CardHeader>
            <CardContent>
              <KubernetesWalkthrough />
            </CardContent>
          </Card>

          {/* ── CTA ── */}
          <div className="flex items-center justify-between rounded-xl border border-blue-100 bg-gradient-to-r from-blue-50 to-cyan-50 px-6 py-5">
            <div>
              <p className="font-semibold text-slate-800">Ready to generate your first manifests?</p>
              <p className="text-sm text-slate-500 mt-0.5">
                Takes &lt; 2 minutes from blank repo to committed Kubernetes YAML.
              </p>
            </div>
            <Button size="lg" className="shrink-0" onClick={() => setLocation("/kubernetes/app")}>
              Start Generating
              <ArrowRight className="w-4 h-4 ml-2" />
            </Button>
          </div>

        </div>
      </main>
    </div>
  );
}
