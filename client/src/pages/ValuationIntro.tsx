import { useLocation } from "wouter";
import Header from "@/components/Header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  ArrowRight,
  Home,
  DollarSign,
  TrendingDown,
  Zap,
  CheckCircle2,
  BarChart3,
  Globe,
  Bell,
  FileCode2,
  Lightbulb,
} from "lucide-react";
import ValuationWalkthrough from "@/components/ValuationWalkthrough";

const VALUE_PROPS = [
  {
    icon: DollarSign,
    color: "text-amber-500",
    bg: "bg-amber-50 border-amber-100",
    headline: "See exactly what Azure is costing you — live",
    detail:
      "Real-time Azure Cost Management data per resource, not catalog estimates — the actual spend on your subscription, right now.",
  },
  {
    icon: TrendingDown,
    color: "text-emerald-500",
    bg: "bg-emerald-50 border-emerald-100",
    headline: "SKU rightsizing before the invoice arrives",
    detail:
      "AI compares your current SKUs against actual usage patterns and recommends specific downgrades with percentage savings calculated.",
  },
  {
    icon: Globe,
    color: "text-blue-500",
    bg: "bg-blue-50 border-blue-100",
    headline: "Every resource group, every resource",
    detail:
      "Full inventory scan across VM, Storage, App Service, Redis, SQL, AKS, and 15+ resource types — nothing missed, nothing estimated.",
  },
  {
    icon: BarChart3,
    color: "text-violet-500",
    bg: "bg-violet-50 border-violet-100",
    headline: "Multi-currency cost reporting",
    detail:
      "View costs in INR, USD, EUR, GBP, JPY, and 15 other currencies — built for global engineering teams and CFO reporting.",
  },
  {
    icon: Lightbulb,
    color: "text-rose-500",
    bg: "bg-rose-50 border-rose-100",
    headline: "Reserved instance savings calculator",
    detail:
      "See your 1-year and 3-year RI savings before buying commitments — specific SKU-level recommendations, not generic advice.",
  },
  {
    icon: Bell,
    color: "text-indigo-500",
    bg: "bg-indigo-50 border-indigo-100",
    headline: "Actionable FinOps — not just dashboards",
    detail:
      "Budget alerts, multi-cloud cost comparison, and tag governance included — the tools FinOps teams actually use, built in.",
  },
];

const WORKFLOW_STEPS = [
  { step: 1, label: "Connect", detail: "Azure subscription credentials" },
  { step: 2, label: "Select Scope", detail: "Choose resource groups" },
  { step: 3, label: "Scan", detail: "Enumerate all resources" },
  { step: 4, label: "Analyze", detail: "Live costs + metrics" },
  { step: 5, label: "Results", detail: "Cost breakdown + savings map" },
  { step: 6, label: "Rightsizing", detail: "SKU recommendations + RI savings" },
];

export default function ValuationIntro() {
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
                  Cloud Cost Intelligence
                </Badge>
                <Badge className="text-xs font-semibold bg-emerald-100 text-emerald-700 hover:bg-emerald-100">
                  Azure Live Data
                </Badge>
              </div>
              <h1 className="text-4xl font-extrabold tracking-tight text-slate-900">
                Stop overpaying for{" "}
                <span className="bg-gradient-to-r from-emerald-600 to-teal-500 bg-clip-text text-transparent">
                  Azure resources
                </span>
              </h1>
              <p className="text-lg text-muted-foreground max-w-2xl">
                Connect your Azure subscription — see every resource's live cost, identify wasted
                spend, and get specific SKU rightsizing recommendations in minutes.
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
                6-step cost audit — from connection to actionable savings report
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {WORKFLOW_STEPS.map(({ step, label, detail }) => (
                  <div key={step} className="flex items-start gap-2.5">
                    <div className="mt-0.5 w-5 h-5 rounded-full bg-gradient-to-br from-emerald-600 to-teal-500 text-white text-[10px] font-bold flex items-center justify-center shrink-0">
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
                  { icon: DollarSign, text: "Azure Retail API + Cost Management queried in real time" },
                  { icon: CheckCircle2, text: "Per-resource cost breakdown with monthly + yearly view" },
                  { icon: TrendingDown, text: "Specific SKU downgrade recommendations with % savings" },
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
              <ValuationWalkthrough />
            </CardContent>
          </Card>

          {/* ── CTA ── */}
          <div className="flex items-center justify-between rounded-xl border border-emerald-100 bg-gradient-to-r from-emerald-50 to-teal-50 px-6 py-5">
            <div>
              <p className="font-semibold text-slate-800">Ready to find your Azure savings?</p>
              <p className="text-sm text-slate-500 mt-0.5">
                Takes &lt; 5 minutes from connection to full cost optimization report.
              </p>
            </div>
            <Button size="lg" className="shrink-0" onClick={() => setLocation("/valuation/app")}>
              Start Analysis
              <ArrowRight className="w-4 h-4 ml-2" />
            </Button>
          </div>

        </div>
      </main>
    </div>
  );
}
