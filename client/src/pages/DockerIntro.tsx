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
  Package,
  Layers,
  FileCode2,
  Search,
} from "lucide-react";
import DockerWalkthrough from "@/components/DockerWalkthrough";

const VALUE_PROPS = [
  {
    icon: Search,
    color: "text-amber-500",
    bg: "bg-amber-50 border-amber-100",
    headline: "Repo scanned, Dockerfile written automatically",
    detail:
      "AI reads your actual source code — detects language, framework, and runtime — then writes the right base image and build steps. No guessing.",
  },
  {
    icon: Layers,
    color: "text-blue-500",
    bg: "bg-blue-50 border-blue-100",
    headline: "Multi-stage builds from day one",
    detail:
      "Smaller images, faster pulls, fewer CVEs — AI applies the multi-stage pattern correctly for your stack without you needing to know it.",
  },
  {
    icon: Package,
    color: "text-cyan-500",
    bg: "bg-cyan-50 border-cyan-100",
    headline: "Docker Compose generated alongside",
    detail:
      "API + database + cache — AI generates a full local dev stack as docker-compose.yml so your team can run everything with one command.",
  },
  {
    icon: ShieldCheck,
    color: "text-emerald-500",
    bg: "bg-emerald-50 border-emerald-100",
    headline: "Security scan before the first push",
    detail:
      "Checkov detects secrets in ENV, privileged mode, missing healthchecks, and latest-tag images — one-click AI fix for every finding.",
  },
  {
    icon: CheckCircle2,
    color: "text-violet-500",
    bg: "bg-violet-50 border-violet-100",
    headline: "Official images, pinned versions, minimal attack surface",
    detail:
      "Best-practice advisor enforces the right base images, non-root users, and version pins automatically — every run, not just when you remember.",
  },
  {
    icon: GitBranch,
    color: "text-indigo-500",
    bg: "bg-indigo-50 border-indigo-100",
    headline: "Dockerfile + .dockerignore + Compose committed together",
    detail:
      "Everything your pipeline needs, in one clean commit — no separate PRs, no forgotten files, no manual copy-paste.",
  },
];

const WORKFLOW_STEPS = [
  { step: 1, label: "Provider", detail: "GitHub or Azure DevOps" },
  { step: 2, label: "Repo & Branch", detail: "Codebase scanned automatically" },
  { step: 3, label: "Stack Detection", detail: "Languages, frameworks, deps" },
  { step: 4, label: "Generate", detail: "Dockerfile + Compose + .dockerignore" },
  { step: 5, label: "Review", detail: "Edit in built-in code editor" },
  { step: 6, label: "Best Practices", detail: "Official images + version pins" },
  { step: 7, label: "Security Scan", detail: "Checkov + AI auto-fix" },
  { step: 8, label: "Commit", detail: "All artifacts in one push" },
];

export default function DockerIntro() {
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
                  Container Builds
                </Badge>
                <Badge className="text-xs font-semibold bg-cyan-100 text-cyan-700 hover:bg-cyan-100">
                  Repo-Aware AI
                </Badge>
              </div>
              <h1 className="text-4xl font-extrabold tracking-tight text-slate-900">
                Scan your repo, get a{" "}
                <span className="bg-gradient-to-r from-cyan-600 to-teal-500 bg-clip-text text-transparent">
                  production Dockerfile
                </span>
              </h1>
              <p className="text-lg text-muted-foreground max-w-2xl">
                AI reads your actual codebase — detects stack, framework, and runtime — then generates
                optimized, security-scanned Docker artifacts and commits them in one workflow.
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
                8-step guided workflow — from codebase to committed Docker artifacts
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {WORKFLOW_STEPS.map(({ step, label, detail }) => (
                  <div key={step} className="flex items-start gap-2.5">
                    <div className="mt-0.5 w-5 h-5 rounded-full bg-gradient-to-br from-cyan-600 to-teal-500 text-white text-[10px] font-bold flex items-center justify-center shrink-0">
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
                  { icon: Lock, text: "Multi-stage build applied automatically for your stack" },
                  { icon: CheckCircle2, text: "Checkov security scan with one-click AI auto-fix" },
                  { icon: Package, text: "Docker Compose generated for the full local dev stack" },
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
              <DockerWalkthrough />
            </CardContent>
          </Card>

          {/* ── CTA ── */}
          <div className="flex items-center justify-between rounded-xl border border-cyan-100 bg-gradient-to-r from-cyan-50 to-teal-50 px-6 py-5">
            <div>
              <p className="font-semibold text-slate-800">Ready to containerize your application?</p>
              <p className="text-sm text-slate-500 mt-0.5">
                Takes &lt; 2 minutes from repo selection to committed Dockerfile.
              </p>
            </div>
            <Button size="lg" className="shrink-0" onClick={() => setLocation("/docker/app")}>
              Start Generating
              <ArrowRight className="w-4 h-4 ml-2" />
            </Button>
          </div>

        </div>
      </main>
    </div>
  );
}
