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
  Network,
  Globe,
  DollarSign,
  FileCode2,
  Layers,
} from "lucide-react";
import ArchMeWalkthrough from "@/components/ArchMeWalkthrough";

const VALUE_PROPS = [
  {
    icon: Zap,
    color: "text-amber-500",
    bg: "bg-amber-50 border-amber-100",
    headline: "Architecture diagrams in 30 seconds",
    detail:
      "Describe your system in plain English — AI renders a fully structured cloud architecture diagram in real time as you type.",
  },
  {
    icon: Globe,
    color: "text-blue-500",
    bg: "bg-blue-50 border-blue-100",
    headline: "Azure, AWS, GCP, multi-cloud",
    detail:
      "Correct service icons, topology, and naming conventions for any cloud provider — or mix them in a single hybrid architecture.",
  },
  {
    icon: Layers,
    color: "text-green-500",
    bg: "bg-green-50 border-green-100",
    headline: "Diagram → full infrastructure code",
    detail:
      "Architecture becomes Terraform, Kubernetes manifests, and automation scripts automatically — no manual translation.",
  },
  {
    icon: ShieldCheck,
    color: "text-emerald-500",
    bg: "bg-emerald-50 border-emerald-100",
    headline: "Security scan + cost estimate included",
    detail:
      "Every generated resource is Checkov-scanned and live-priced before you review — no surprises in the first deployment.",
  },
  {
    icon: Network,
    color: "text-violet-500",
    bg: "bg-violet-50 border-violet-100",
    headline: "Stakeholder-ready diagrams before a line deploys",
    detail:
      "Share a visual architecture with non-technical stakeholders in seconds — no Visio, no manual diagramming tools.",
  },
  {
    icon: GitBranch,
    color: "text-indigo-500",
    bg: "bg-indigo-50 border-indigo-100",
    headline: "Full infrastructure committed from one description",
    detail:
      "README, Terraform, K8s, CI/CD scripts — all generated and pushed to your repo from a single architecture description.",
  },
];

const WORKFLOW_STEPS = [
  { step: 1, label: "Describe", detail: "Natural language architecture" },
  { step: 2, label: "Repository", detail: "GitHub or Azure DevOps" },
  { step: 3, label: "Diagram", detail: "Cloud-native diagram generated" },
  { step: 4, label: "Components", detail: "Services & dependencies extracted" },
  { step: 5, label: "Code", detail: "Terraform + K8s + automation" },
  { step: 6, label: "Security", detail: "Checkov scan + AI auto-fix" },
  { step: 7, label: "Cost", detail: "Live pricing per resource" },
  { step: 8, label: "Commit", detail: "All artifacts pushed to repo" },
];

export default function ArchMeIntro() {
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
                  Architecture as Code
                </Badge>
                <Badge className="text-xs font-semibold bg-emerald-100 text-emerald-700 hover:bg-emerald-100">
                  Multi-Cloud
                </Badge>
              </div>
              <h1 className="text-4xl font-extrabold tracking-tight text-slate-900">
                Plain English →{" "}
                <span className="bg-gradient-to-r from-green-600 to-emerald-500 bg-clip-text text-transparent">
                  cloud architecture + code
                </span>
              </h1>
              <p className="text-lg text-muted-foreground max-w-2xl">
                Describe your system. Get a stakeholder-ready diagram and full infrastructure code —
                Terraform, Kubernetes, automation scripts — scanned, priced, and committed.
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
                8-step workflow — from description to committed infrastructure code
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {WORKFLOW_STEPS.map(({ step, label, detail }) => (
                  <div key={step} className="flex items-start gap-2.5">
                    <div className="mt-0.5 w-5 h-5 rounded-full bg-gradient-to-br from-green-600 to-emerald-500 text-white text-[10px] font-bold flex items-center justify-center shrink-0">
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
                  { icon: Lock, text: "Checkov scans all generated Terraform and K8s files" },
                  { icon: DollarSign, text: "Live Azure/AWS/GCP pricing per resource" },
                  { icon: CheckCircle2, text: "README auto-generated with architecture summary" },
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
              <ArchMeWalkthrough />
            </CardContent>
          </Card>

          {/* ── CTA ── */}
          <div className="flex items-center justify-between rounded-xl border border-green-100 bg-gradient-to-r from-green-50 to-emerald-50 px-6 py-5">
            <div>
              <p className="font-semibold text-slate-800">Ready to design your cloud architecture?</p>
              <p className="text-sm text-slate-500 mt-0.5">
                Takes &lt; 2 minutes from blank description to committed infrastructure code.
              </p>
            </div>
            <Button size="lg" className="shrink-0" onClick={() => setLocation("/archme/app")}>
              Start Designing
              <ArrowRight className="w-4 h-4 ml-2" />
            </Button>
          </div>

        </div>
      </main>
    </div>
  );
}
