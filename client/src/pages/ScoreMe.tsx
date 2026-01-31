import { useState, useEffect } from "react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { useSecretsConfig } from "@/hooks/useSecretsConfig";
import { ArrowRight, Download, FileChartPie } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import RepositoryList, { Repository } from "@/components/RepositoryList";

interface ScoreMeReportPayload {
  repository: string;
  provider: "github" | "azure";
  inventory: Array<{ type: string; path: string; summary: string }>;
  findings: Array<{
    category: string;
    severity: string;
    message: string;
    file?: string;
    remediation: string;
  }>;
  pillarScores: Array<{ name: string; score: number; weight: number; details: string[] }>;
  finalScore: number;
  confidence: string;
  updatedAt: string;
}

export default function ScoreMe() {
  const { toast } = useToast();
  const { data: config } = useSecretsConfig();
  const [provider, setProvider] = useState<"github" | "azure">("github");
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);
  const [report, setReport] = useState<ScoreMeReportPayload | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  const {
    data: repositories = [],
    error: repositoriesError,
    isFetching: repositoriesLoading,
  } = useQuery<Repository[]>({
    queryKey: ["/api/repositories", provider],
    enabled: !!provider,
  });

  useEffect(() => {
    if (repositories.length === 0) {
      setSelectedRepoId(null);
      return;
    }

    setSelectedRepoId((prev) => (prev && repositories.some((repo) => repo.id === prev) ? prev : repositories[0].id));
  }, [repositories]);

  useEffect(() => {
    if (repositoriesError) {
      const errorMessage =
        (repositoriesError as any).message || "Failed to load repositories. Check your cloud credentials.";
      toast({
        title: "Could not fetch repositories",
        description: errorMessage,
        variant: "destructive",
      });
    }
  }, [repositoriesError, toast]);

  const handleRunScore = async () => {
    const selectedRepository = repositories.find((repo) => repo.id === selectedRepoId);
    if (!selectedRepository) {
      toast({ title: "Repository required", description: "Enter the repository name before running ScoreMe.", variant: "destructive" });
      return;
    }

    setIsRunning(true);
    try {
      const response = await apiRequest("POST", "/api/scoreme/run", {
        provider,
        repositoryId: selectedRepository.id,
        repositoryName: selectedRepository.name,
        repositoryFullName: selectedRepository.fullName ?? selectedRepository.name,
        branch: selectedRepository.branch,
      });
      const payload = await response.json();
      setReport(payload);
    } catch (error: any) {
      toast({ title: "ScoreMe failed", description: error?.message || "Unable to analyze the repository", variant: "destructive" });
    } finally {
      setIsRunning(false);
    }
  };

  const handleDownloadReport = () => {
    if (!report) {
      return;
    }

    const safeName = report.repository.replace(/\//g, "_");
    const html = buildReportHtml(report);
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${safeName}-scoreme-report.html`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const buildReportHtml = (payload: ScoreMeReportPayload) => {
    const pillarHtml = payload.pillarScores
      .map(
        (pillar) => `
          <div class="pillar-card">
            <div class="label">
              <span>${pillar.name}</span>
              <span>${pillar.score.toFixed(1)}%</span>
            </div>
            <div class="bar">
              <div class="fill" style="width:${pillar.score}%"></div>
            </div>
            <div class="details">
              ${pillar.details.map((detail) => `<p>${detail}</p>`).join("")}
            </div>
          </div>
        `
      )
      .join("");

    const inventoryHtml = payload.inventory
      .map(
        (entry) => `
          <div class="inventory-row">
            <span class="inventory-type">${entry.type}</span>
            <span class="inventory-path">${entry.path}</span>
            <span class="inventory-summary">${entry.summary}</span>
          </div>
        `
      )
      .join("");

    const findingsHtml = payload.findings
      .map(
        (finding) => `
          <div class="finding-card">
            <div class="finding-header">
              <span>${finding.category}</span>
              <span class="severity">${finding.severity}</span>
            </div>
            <p class="finding-message">${finding.message}</p>
            ${finding.file ? `<p class="finding-file">File: ${finding.file}</p>` : ""}
            <p class="finding-remediation">Remediation: ${finding.remediation}</p>
          </div>
        `
      )
      .join("");

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8" />
        <title>ScoreMe Report – ${payload.repository}</title>
        <style>
          body { font-family: 'Inter', system-ui, sans-serif; background:#f9fafb; color:#111827; margin:0; padding:24px; }
          h1 { margin-bottom:0.25rem; }
          .head { display:flex; justify-content:space-between; align-items:flex-end; flex-wrap:wrap; gap:12px; margin-bottom:24px; }
          .score-pill { font-size:1.25rem; font-weight:600; }
          .confidence { font-size:0.95rem; }
          .section { margin-bottom:28px; }
          .card { background:#fff; border-radius:20px; padding:20px; box-shadow:0 10px 30px rgba(15,23,42,0.08); }
          .pillar-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:18px; }
          .pillar-card { border:1px solid #e5e7eb; border-radius:16px; padding:16px; background:#fcfcfd; }
          .pillar-card .label { display:flex; justify-content:space-between; font-weight:600; margin-bottom:8px; }
          .bar { width:100%; height:10px; border-radius:999px; background:#e5e7eb; overflow:hidden; margin-bottom:6px; }
          .fill { height:100%; border-radius:999px; background:linear-gradient(90deg,#2563eb,#10b981); }
          .details { font-size:0.75rem; color:#4b5563; line-height:1.4; }
          .inventory-row { display:grid; grid-template-columns:140px 1fr 220px; gap:12px; padding:10px 0; border-bottom:1px solid #e5e7eb; }
          .inventory-row:last-child { border-bottom:none; }
          .inventory-type { font-weight:600; text-transform:capitalize; }
          .finding-card { border:1px solid #e5e7eb; border-radius:16px; padding:14px; margin-bottom:12px; background:#fff; }
          .finding-header { display:flex; justify-content:space-between; align-items:center; font-weight:600; }
          .severity { font-size:0.75rem; text-transform:uppercase; padding:2px 8px; border-radius:999px; background:#ede9fe; color:#7c3aed; }
          .finding-message { margin:8px 0 4px; }
          .finding-file { font-size:0.75rem; color:#6b7280; }
          .finding-remediation { font-size:0.8rem; font-weight:600; color:#111827; }
        </style>
      </head>
      <body>
        <div class="head">
          <div>
            <h1>ScoreMe Report</h1>
            <p class="confidence">Confidence: ${payload.confidence}</p>
            <p class="confidence">Provider: ${payload.provider.toUpperCase()} · Repository: ${payload.repository}</p>
          </div>
          <div class="score-pill">Final Score: ${payload.finalScore.toFixed(1)}%</div>
        </div>

        <div class="section card">
          <h2>Pillar Scores</h2>
          <div class="pillar-grid">${pillarHtml}</div>
        </div>

        <div class="section card">
          <h2>Inventory</h2>
          ${inventoryHtml || "<p>No inventory entries were detected.</p>"}
        </div>

        <div class="section card">
          <h2>Findings & Remediation</h2>
          ${findingsHtml || "<p>No findings were generated.</p>"}
        </div>
      </body>
      </html>
    `;
    return html;
  };

  const confidenceColor = (confidence: string) => {
    if (confidence === "Production-ready") return "text-emerald-600";
    if (confidence === "Needs minor fixes") return "text-blue-600";
    if (confidence === "Risky") return "text-orange-600";
    return "text-red-600";
  };

  return (
    <div className="min-h-screen bg-background py-12">
      <div className="container mx-auto px-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold">ScoreMe</h1>
            <p className="text-muted-foreground">
              Run an AI-powered confidence report for your IaC and automation assets.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => window.location.reload()}>
              Refresh
            </Button>
            <Button variant="ghost" size="sm" onClick={() => (window.location.href = "/")}>
              Home
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setProvider("github")}>
              GitHub
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setProvider("azure")}>
              Azure DevOps
            </Button>
          </div>
        </div>

        <Card className="mb-8 border-border/50 shadow-lg">
          <CardHeader className="bg-primary/5 border-b border-border/50">
            <div className="flex justify-between items-center">
              <CardTitle>Repository Details</CardTitle>
              <CardDescription>Score provider: {provider.toUpperCase()}</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
                <label className="text-sm font-semibold">Repository</label>
                {repositories.length > 0 ? (
                  <RepositoryList
                    repositories={repositories}
                    selectedId={selectedRepoId ?? undefined}
                    onSelect={setSelectedRepoId}
                    showSearch
                    hideCard
                    className="border border-border/50 rounded-2xl bg-background/50 shadow-sm"
                  />
                ) : repositoriesLoading ? (
                  <p className="text-sm text-muted-foreground">Loading repositories...</p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No repositories found for the selected provider. Ensure your cloud credentials are configured in Settings.
                  </p>
                )}
            </div>
            <div className="flex justify-end">
                <Button
                  onClick={handleRunScore}
                  disabled={isRunning || repositories.length === 0 || !selectedRepoId}
                >
                {isRunning ? "Analyzing..." : "Run ScoreMe"} <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
            </div>
          </CardContent>
        </Card>

        {report && (
          <div className="space-y-6">
            <div className="rounded-3xl bg-white/80 shadow-2xl border border-border/60 p-6 space-y-8">
              <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
                <div>
                  <h2 className="text-3xl font-semibold text-slate-900">ScoreSheet</h2>
                  <p className="text-sm text-muted-foreground">
                    Provider: {provider.toUpperCase()} · Repository: {report.repository}
                  </p>
                  <p className={`mt-2 text-lg font-semibold ${confidenceColor(report.confidence)}`}>
                    Confidence: {report.confidence}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <div className="text-center">
                    <p className="text-xs uppercase tracking-widest text-muted-foreground">Final score</p>
                    <p className="text-4xl font-bold text-primary">{report.finalScore.toFixed(1)}%</p>
                  </div>
                  <Button variant="outline" size="sm" className="gap-1" onClick={handleDownloadReport}>
                    <Download className="w-4 h-4" />
                    Download ScoreSheet
                  </Button>
                </div>
              </div>
              <div className="text-xs text-muted-foreground">Updated {new Date(report.updatedAt).toLocaleString()}</div>

              <div className="space-y-4">
                <h3 className="text-xl font-semibold">Pillar Scores</h3>
                <div className="grid md:grid-cols-4 gap-4">
                  {report.pillarScores.map((pillar) => (
                    <div key={pillar.name} className="rounded-2xl border border-border/40 bg-slate-50 p-4 space-y-3">
                      <div className="flex items-center justify-between text-sm font-semibold">
                        <span>{pillar.name}</span>
                        <span>{pillar.score.toFixed(1)}%</span>
                      </div>
                      <div className="h-2 w-full rounded-full bg-slate-200">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-blue-600 to-green-500 transition-all"
                          style={{ width: `${pillar.score}%` }}
                        />
                      </div>
                      <div className="text-[11px] text-muted-foreground uppercase tracking-[0.3em]">Weight {(pillar.weight * 100).toFixed(0)}%</div>
                      <div className="text-xs text-muted-foreground space-y-1">
                        {pillar.details.map((detail) => (
                          <p key={detail}>• {detail}</p>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="space-y-4">
                <h3 className="text-xl font-semibold">Inventory</h3>
                <div className="grid gap-2">
                  {report.inventory.map((entry) => (
                    <div key={entry.path} className="grid grid-cols-1 md:grid-cols-[180px_1fr_200px] gap-4 rounded-xl border border-border/30 bg-white p-4">
                      <span className="font-semibold uppercase tracking-[0.4em] text-xs text-muted-foreground">{entry.type}</span>
                      <div>
                        <p className="text-sm font-medium text-slate-900">{entry.path}</p>
                        <p className="text-xs text-muted-foreground">{entry.summary}</p>
                        {entry.files?.length ? (
                          <div className="mt-2 text-xs text-slate-600 space-y-1">
                            <p className="font-semibold">Files scanned</p>
                            <ul className="list-disc list-inside text-xs space-y-0.5 max-h-32 overflow-y-auto">
                              {entry.files.map((file) => (
                                <li key={file}>{file}</li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                      </div>
                      <span className="text-xs text-muted-foreground hidden md:block">{entry.summary}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="space-y-4">
                <h3 className="text-xl font-semibold">Findings & Remediation</h3>
                <div className="grid gap-3">
                  {report.findings.map((finding) => (
                    <div
                      key={`${finding.category}-${finding.message}`}
                      className="rounded-2xl border border-border/40 bg-white p-4 space-y-2 shadow-sm"
                    >
                      <div className="flex items-center justify-between text-sm font-semibold">
                        <span>{finding.category}</span>
                        <span className={`px-2 py-0.5 text-[11px] font-semibold rounded-full ${finding.severity === "critical" ? "bg-rose-100 text-rose-600" : finding.severity === "high" ? "bg-orange-100 text-orange-600" : finding.severity === "medium" ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-500"}`}>
                          {finding.severity}
                        </span>
                      </div>
                      <p className="text-sm text-slate-800">{finding.message}</p>
                      {finding.file && <p className="text-xs text-muted-foreground">File: {finding.file}</p>}
                      <p className="text-sm font-semibold text-slate-900">Remediation</p>
                      <p className="text-sm text-muted-foreground">{finding.remediation}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

