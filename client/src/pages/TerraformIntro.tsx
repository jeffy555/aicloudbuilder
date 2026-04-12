import { useLocation } from "wouter";
import Header from "@/components/Header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  ArrowRight,
  Home,
  ShieldCheck,
  DollarSign,
  GitBranch,
  Zap,
  Globe,
  Lock,
  TrendingDown,
  FileCode2,
  CheckCircle2,
} from "lucide-react";
import TerraformWalkthrough from "@/components/TerraformWalkthrough";

const VALUE_PROPS = [
  {
    icon: Zap,
    color: "text-amber-500",
    bg: "bg-amber-50 border-amber-100",
    headline: "10× faster than writing by hand",
    detail:
      "Describe your infrastructure in plain English — get production-ready Terraform in seconds, not hours.",
  },
  {
    icon: Globe,
    color: "text-blue-500",
    bg: "bg-blue-50 border-blue-100",
    headline: "Azure · AWS · GCP — one workflow",
    detail:
      "Switch cloud providers without relearning a tool. Multi-cloud cost comparison is built in.",
  },
  {
    icon: ShieldCheck,
    color: "text-emerald-500",
    bg: "bg-emerald-50 border-emerald-100",
    headline: "Zero-tolerance security, auto-fixed",
    detail:
      "Checkov scans every file the moment it's generated. Failed checks get an AI-generated fix with one click.",
  },
  {
    icon: DollarSign,
    color: "text-violet-500",
    bg: "bg-violet-50 border-violet-100",
    headline: "Know the cost before you deploy",
    detail:
      "Live Azure Retail + AWS + GCP pricing per resource. Monthly and yearly estimates with usage-profile controls.",
  },
  {
    icon: TrendingDown,
    color: "text-rose-500",
    bg: "bg-rose-50 border-rose-100",
    headline: "AI rightsizing built in",
    detail:
      "Every generation includes SKU recommendations and savings percentages so you never over-provision on day one.",
  },
  {
    icon: GitBranch,
    color: "text-indigo-500",
    bg: "bg-indigo-50 border-indigo-100",
    headline: "Commit directly to GitHub or Azure DevOps",
    detail:
      "Review, edit, scan, and push — all without leaving the platform. No copy-paste, no context switching.",
  },
];

const WORKFLOW_STEPS = [
  { step: 1, label: "Provider", detail: "GitHub or Azure DevOps" },
  { step: 2, label: "Repository", detail: "Existing or new repo" },
  { step: 3, label: "Cloud", detail: "Azure / AWS / GCP" },
  { step: 4, label: "Module Type", detail: "Child · Standalone · Aggregated" },
  { step: 5, label: "Backend", detail: "State storage configured" },
  { step: 6, label: "Generate", detail: "AI writes your .tf files" },
  { step: 7, label: "Review", detail: "Edit in built-in code editor" },
  { step: 8, label: "Scan & Cost", detail: "Security + pricing analysis" },
];

export default function TerraformIntro() {
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
                  Infrastructure as Code
                </Badge>
                <Badge className="text-xs font-semibold bg-emerald-100 text-emerald-700 hover:bg-emerald-100">
                  Multi-Cloud
                </Badge>
              </div>
              <h1 className="text-4xl font-extrabold tracking-tight text-slate-900">
                Turn plain English into{" "}
                <span className="bg-gradient-to-r from-blue-600 to-emerald-500 bg-clip-text text-transparent">
                  production Terraform
                </span>
              </h1>
              <p className="text-lg text-muted-foreground max-w-2xl">
                Describe what you want to build. We generate secure, cost-optimised, multi-cloud
                Terraform — scanned, priced, and committed to your repo in one workflow.
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
                8-step guided workflow — nothing to configure upfront
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {WORKFLOW_STEPS.map(({ step, label, detail }) => (
                  <div key={step} className="flex items-start gap-2.5">
                    <div className="mt-0.5 w-5 h-5 rounded-full bg-gradient-to-br from-blue-600 to-emerald-500 text-white text-[10px] font-bold flex items-center justify-center shrink-0">
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
                  { icon: Lock, text: "State backend auto-provisioned on Azure, AWS, or GCS" },
                  { icon: CheckCircle2, text: "Checkov security scan with one-click AI auto-fix" },
                  { icon: DollarSign, text: "Per-resource cost breakdown before you commit" },
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
              <TerraformWalkthrough />
            </CardContent>
          </Card>

          {/* ── CTA ── */}
          <div className="flex items-center justify-between rounded-xl border border-blue-100 bg-gradient-to-r from-blue-50 to-emerald-50 px-6 py-5">
            <div>
              <p className="font-semibold text-slate-800">Ready to generate your first infrastructure?</p>
              <p className="text-sm text-slate-500 mt-0.5">
                Takes &lt; 2 minutes from blank repo to committed .tf files.
              </p>
            </div>
            <Button size="lg" className="shrink-0" onClick={() => setLocation("/terraform/app")}>
              Start Generating
              <ArrowRight className="w-4 h-4 ml-2" />
            </Button>
          </div>

        </div>
      </main>
    </div>
  );
}
