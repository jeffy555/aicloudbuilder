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
  CheckCircle2,
  BarChart3,
  Download,
  Search,
  FileCode2,
  FileSearch,
} from "lucide-react";
import ScoreMeWalkthrough from "@/components/ScoreMeWalkthrough";

const VALUE_PROPS = [
  {
    icon: Zap,
    color: "text-amber-500",
    bg: "bg-amber-50 border-amber-100",
    headline: "Full IaC audit in under 3 minutes",
    detail:
      "One click analyzes every Terraform, Kubernetes, Helm, and Docker file in your repository — no configuration, no agent installation.",
  },
  {
    icon: BarChart3,
    color: "text-blue-500",
    bg: "bg-blue-50 border-blue-100",
    headline: "4-pillar weighted confidence score",
    detail:
      "Security (40%) · Coverage (25%) · Scanning (20%) · Containers (15%) — an objective, auditable score, not a gut feel.",
  },
  {
    icon: ShieldCheck,
    color: "text-emerald-500",
    bg: "bg-emerald-50 border-emerald-100",
    headline: "Checkov finds what PR reviews miss",
    detail:
      "Automated detection of misconfigurations, policy violations, and security gaps across all IaC types simultaneously.",
  },
  {
    icon: FileSearch,
    color: "text-violet-500",
    bg: "bg-violet-50 border-violet-100",
    headline: "Actionable remediation, not just findings",
    detail:
      "Every finding comes with a specific fix instruction — exactly what to change, not just which file has the problem.",
  },
  {
    icon: GitBranch,
    color: "text-rose-500",
    bg: "bg-rose-50 border-rose-100",
    headline: "Works on any provider — no migration",
    detail:
      "GitHub or Azure DevOps — point at your existing repo, no branch migration, no new tooling, no service principal setup.",
  },
  {
    icon: Download,
    color: "text-indigo-500",
    bg: "bg-indigo-50 border-indigo-100",
    headline: "Downloadable ScoreSheet for auditors",
    detail:
      "One-click HTML report with score, inventory, findings, and remediations — ready for compliance reviews and security handoffs.",
  },
];

const WORKFLOW_STEPS = [
  { step: 1, label: "Provider", detail: "GitHub or Azure DevOps" },
  { step: 2, label: "Repository", detail: "Select repo to analyze" },
  { step: 3, label: "Auto-Scan", detail: "Fetch, classify, run Checkov" },
  { step: 4, label: "Score", detail: "4-pillar weighted result" },
  { step: 5, label: "Inventory", detail: "All IaC assets catalogued" },
  { step: 6, label: "Findings", detail: "Severities + remediation" },
];

export default function ScoreMeIntro() {
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
                  IaC Quality Audit
                </Badge>
                <Badge className="text-xs font-semibold bg-pink-100 text-pink-700 hover:bg-pink-100">
                  Multi-Framework
                </Badge>
              </div>
              <h1 className="text-4xl font-extrabold tracking-tight text-slate-900">
                Know your IaC quality{" "}
                <span className="bg-gradient-to-r from-pink-600 to-rose-500 bg-clip-text text-transparent">
                  before it reaches prod
                </span>
              </h1>
              <p className="text-lg text-muted-foreground max-w-2xl">
                Point at any IaC repository — get a weighted confidence score, Checkov security
                findings, and specific remediation guidance in under 3 minutes.
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
                6-step automated audit — nothing to configure upfront
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {WORKFLOW_STEPS.map(({ step, label, detail }) => (
                  <div key={step} className="flex items-start gap-2.5">
                    <div className="mt-0.5 w-5 h-5 rounded-full bg-gradient-to-br from-pink-600 to-rose-500 text-white text-[10px] font-bold flex items-center justify-center shrink-0">
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
                  { icon: Search, text: "Terraform, K8s, Helm, Docker, Bicep, ARM all scanned" },
                  { icon: CheckCircle2, text: "Checkov runs 200+ security and compliance checks" },
                  { icon: Download, text: "HTML ScoreSheet downloadable for audits and reviews" },
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
              <ScoreMeWalkthrough />
            </CardContent>
          </Card>

          {/* ── CTA ── */}
          <div className="flex items-center justify-between rounded-xl border border-pink-100 bg-gradient-to-r from-pink-50 to-rose-50 px-6 py-5">
            <div>
              <p className="font-semibold text-slate-800">Ready to audit your infrastructure?</p>
              <p className="text-sm text-slate-500 mt-0.5">
                Takes &lt; 3 minutes from repo selection to full ScoreSheet report.
              </p>
            </div>
            <Button size="lg" className="shrink-0" onClick={() => setLocation("/scoreme/app")}>
              Run ScoreMe
              <ArrowRight className="w-4 h-4 ml-2" />
            </Button>
          </div>

        </div>
      </main>
    </div>
  );
}
