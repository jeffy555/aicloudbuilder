import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import Header from "@/components/Header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import mermaid from "mermaid";
import {
  Clock,
  MessageSquare,
  FileCode,
  ArrowRight,
  History as HistoryIcon,
  Layers,
  Container,
  Terminal,
  Blocks,
  Ship,
  Award,
  FolderOpen,
  GitBranch,
  Timer,
  CheckCircle2,
  XCircle,
  Loader2,
  ChevronDown,
  ChevronRight,
  PlayCircle,
  Package,
  CalendarDays,
} from "lucide-react";

// ─── Constants ───────────────────────────────────────────────────────────────

const MODULES = [
  { key: "all", label: "All" },
  { key: "terraform", label: "Terraform" },
  { key: "kubernetes", label: "Kubernetes" },
  { key: "docker", label: "Docker" },
  { key: "archme", label: "ArchMe" },
  { key: "automation", label: "Automation" },
  { key: "scoreme", label: "ScoreMe" },
] as const;

const MODULE_COLORS: Record<string, string> = {
  terraform:  "bg-violet-100 text-violet-700 border-violet-200 dark:bg-violet-900/30 dark:text-violet-300 dark:border-violet-800",
  kubernetes: "bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-800",
  docker:     "bg-cyan-100 text-cyan-700 border-cyan-200 dark:bg-cyan-900/30 dark:text-cyan-300 dark:border-cyan-800",
  archme:     "bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-800",
  automation: "bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-800",
  scoreme:    "bg-rose-100 text-rose-700 border-rose-200 dark:bg-rose-900/30 dark:text-rose-300 dark:border-rose-800",
  helm:       "bg-teal-100 text-teal-700 border-teal-200 dark:bg-teal-900/30 dark:text-teal-300 dark:border-teal-800",
  unknown:    "bg-gray-100 text-gray-600 border-gray-200 dark:bg-gray-800 dark:text-gray-400 dark:border-gray-700",
};

const MODULE_ICONS: Record<string, React.ReactNode> = {
  terraform:  <Layers className="w-3.5 h-3.5" />,
  kubernetes: <Container className="w-3.5 h-3.5" />,
  automation: <Terminal className="w-3.5 h-3.5" />,
  archme:     <Blocks className="w-3.5 h-3.5" />,
  docker:     <Ship className="w-3.5 h-3.5" />,
  scoreme:    <Award className="w-3.5 h-3.5" />,
  helm:       <Package className="w-3.5 h-3.5" />,
  unknown:    <FolderOpen className="w-3.5 h-3.5" />,
};

const MODULE_ROUTES: Record<string, string> = {
  terraform:  "/terraform",
  kubernetes: "/kubernetes",
  automation: "/automation",
  archme:     "/archme",
  docker:     "/docker",
  scoreme:    "/scoreme",
};

const SESSION_STORAGE_KEYS: Record<string, string> = {
  terraform:  "terraform_workflow_session_id",
  kubernetes: "kubernetes_workflow_session_id",
  automation: "automation_workflow_session_id",
  archme:     "archme_workflow_session_id",
  docker:     "docker_workflow_session_id",
};

const STAGE_LABELS: Record<string, string> = {
  diagram:  "Architecture",
  refactor: "Best Approach",
  cost:     "Cost Analysis",
  security: "Security Scan",
  validate: "Best Practices",
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function formatExactDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = Math.floor(secs % 60);
  return `${mins}m ${remainSecs}s`;
}

function normalizeStage(stage: string): string {
  const s = String(stage || "").toLowerCase();
  if (s.includes("diagram") || s.includes("architecture")) return "diagram";
  if (s.includes("cost")) return "cost";
  if (s.includes("security") || s.includes("scan")) return "security";
  if (s.includes("refactor") || s.includes("best")) return "refactor";
  return s;
}

function getStageLabel(stage: string): string {
  const normalized = normalizeStage(stage);
  return STAGE_LABELS[normalized] || STAGE_LABELS[stage] || stage;
}

function MermaidPreview({ syntax }: { syntax: string }) {
  const [svg, setSvg] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    mermaid.initialize({
      startOnLoad: false,
      theme: "default",
      securityLevel: "strict",
      flowchart: { useMaxWidth: true, htmlLabels: false, curve: "basis" },
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    const render = async () => {
      if (!syntax?.trim()) {
        setSvg("");
        return;
      }
      try {
        setError(null);
        const { svg: rendered } = await mermaid.render(`history-mermaid-${Date.now()}`, syntax.trim());
        if (!cancelled) {
          setSvg(rendered);
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(err?.message || "Unable to render architecture diagram");
        }
      }
    };
    void render();
    return () => {
      cancelled = true;
    };
  }, [syntax]);

  if (error) return <p className="text-sm text-rose-600">{error}</p>;
  if (!svg) return <p className="text-sm text-muted-foreground">Rendering architecture diagram...</p>;
  return (
    <div className="max-h-[72vh] overflow-auto rounded-md border bg-white p-3">
      <div className="min-w-[980px]" dangerouslySetInnerHTML={{ __html: svg }} />
    </div>
  );
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface EnrichedSession {
  id: string;
  repositoryName: string | null;
  currentStep: string;
  workflowStep: string;
  activeModule: string | null;
  inferredModule: string;
  messageCount: number;
  fileCount: number;
  createdAt: string;
  updatedAt: string;
}

interface UserActivityItem {
  id: string;
  module: string;
  actionType: string;
  actionLabel: string;
  metadata: any;
  createdAt: string;
}

interface HistoryResponse {
  sessions: EnrichedSession[];
  activities: UserActivityItem[];
  totalSessions: number;
  totalActivities: number;
}

interface BuildRecord {
  id: string;
  buildId: string;
  sessionId: string;
  module: string;
  status: string;
  pipelineStages: string[] | null;
  stages: Array<{ name: string; status: string; completedAt?: string }> | null;
  filesGenerated: number | null;
  repositoryName: string | null;
  repositoryBranch: string | null;
  totalDurationMs: number | null;
  createdAt: string;
  completedAt: string | null;
  metadata?: Record<string, any> | null;
}

// ─── Build Run Card ───────────────────────────────────────────────────────────

function BuildRunCard({ build }: { build: BuildRecord }) {
  const [expanded, setExpanded] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [selectedStage, setSelectedStage] = useState<string | null>(null);

  const mod = build.module || "unknown";
  const modColor = MODULE_COLORS[mod] || MODULE_COLORS.unknown;
  const modIcon  = MODULE_ICONS[mod]  || MODULE_ICONS.unknown;

  const statusBadge =
    build.status === "completed" ? (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full bg-emerald-100 text-emerald-700 border border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-800">
        <CheckCircle2 className="w-3.5 h-3.5" /> Completed
      </span>
    ) : build.status === "failed" ? (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full bg-rose-100 text-rose-700 border border-rose-200 dark:bg-rose-900/30 dark:text-rose-300 dark:border-rose-800">
        <XCircle className="w-3.5 h-3.5" /> Failed
      </span>
    ) : (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full bg-blue-100 text-blue-700 border border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-800">
        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Running
      </span>
    );

  const selectedStageNormalized = normalizeStage(selectedStage || "");
  const terraformDetails = (build.metadata as any)?.terraformBuildDetails || (build.metadata as any) || null;
  const canOpenStageDetail = (stage: string) =>
    mod === "terraform" && ["diagram", "cost", "security"].includes(normalizeStage(stage));

  return (
    <Card className="overflow-hidden hover:shadow-md transition-shadow">
      <CardContent className="p-0">
        {/* Header row */}
        <button
          className="w-full text-left px-5 py-4 flex items-start gap-4 hover:bg-muted/40 transition-colors"
          onClick={() => setExpanded(!expanded)}
        >
          {/* Build ID + timestamp */}
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2 mb-2">
              <span className="font-mono text-sm font-bold tracking-tight">{build.buildId}</span>
              {statusBadge}
              <Badge variant="outline" className={`text-[11px] px-2 py-0.5 border ${modColor} flex items-center gap-1`}>
                {modIcon}
                <span className="ml-0.5 capitalize">{mod}</span>
              </Badge>
            </div>

            {/* Timestamps */}
            <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <PlayCircle className="w-3.5 h-3.5" />
                <span className="font-medium">Started:</span> {formatExactDate(build.createdAt)}
                <span className="opacity-60">({timeAgo(build.createdAt)})</span>
              </span>
              {build.completedAt && (
                <span className="flex items-center gap-1.5">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                  <span className="font-medium">Finished:</span> {formatExactDate(build.completedAt)}
                </span>
              )}
              {build.totalDurationMs != null && (
                <span className="flex items-center gap-1.5">
                  <Timer className="w-3.5 h-3.5" />
                  {formatDuration(build.totalDurationMs)}
                </span>
              )}
            </div>
          </div>

          {/* Expand toggle */}
          <div className="flex-shrink-0 mt-1">
            {expanded
              ? <ChevronDown className="w-4 h-4 text-muted-foreground" />
              : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
          </div>
        </button>

        {/* Pipeline stages row — always visible */}
        {build.pipelineStages && build.pipelineStages.length > 0 && (
          <div className="px-5 pb-3 flex flex-wrap gap-1.5">
            {build.pipelineStages.map((stage, i) => (
              canOpenStageDetail(stage) ? (
                <button
                  key={i}
                  type="button"
                  onClick={() => {
                    setSelectedStage(stage);
                    setDetailOpen(true);
                  }}
                  className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-muted border font-medium hover:bg-accent transition-colors"
                  title="Click to view stage details"
                >
                  <CheckCircle2 className="w-2.5 h-2.5 text-emerald-500" />
                  {getStageLabel(stage)}
                </button>
              ) : (
                <span
                  key={i}
                  className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-muted border font-medium"
                >
                  <CheckCircle2 className="w-2.5 h-2.5 text-emerald-500" />
                  {getStageLabel(stage)}
                </span>
              )
            ))}
          </div>
        )}

        {/* Expanded details */}
        {expanded && (
          <div className="border-t bg-muted/30 px-5 py-4 space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm">
              {build.repositoryName && (
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">Repository</p>
                  <div className="flex items-center gap-1.5 font-medium">
                    <GitBranch className="w-3.5 h-3.5 text-muted-foreground" />
                    <span className="truncate">{build.repositoryName}</span>
                    {build.repositoryBranch && (
                      <span className="text-xs text-muted-foreground">({build.repositoryBranch})</span>
                    )}
                  </div>
                </div>
              )}
              {build.filesGenerated != null && (
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">Files Generated</p>
                  <div className="flex items-center gap-1.5 font-medium">
                    <FileCode className="w-3.5 h-3.5 text-muted-foreground" />
                    {build.filesGenerated} files
                  </div>
                </div>
              )}
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">Session ID</p>
                <span className="font-mono text-xs text-muted-foreground truncate block">{build.sessionId.slice(0, 16)}…</span>
              </div>
            </div>

            {/* Full date row */}
            <div className="rounded-lg bg-background border px-3 py-2 text-xs space-y-1">
              <div className="flex items-center gap-2 text-muted-foreground">
                <CalendarDays className="w-3.5 h-3.5 flex-shrink-0" />
                <span><span className="font-medium">Started:</span> {formatExactDate(build.createdAt)}</span>
              </div>
              {build.completedAt && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0 text-emerald-500" />
                  <span><span className="font-medium">Completed:</span> {formatExactDate(build.completedAt)}</span>
                </div>
              )}
            </div>
          </div>
        )}
      </CardContent>

      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className={selectedStageNormalized === "diagram" ? "max-w-[95vw] w-[95vw]" : "max-w-3xl"}>
          <DialogHeader>
            <DialogTitle>{getStageLabel(selectedStage || "Stage")} — {build.buildId}</DialogTitle>
            <DialogDescription>
              Terraform build stage details captured during pipeline completion.
            </DialogDescription>
          </DialogHeader>

          {selectedStageNormalized === "diagram" && (
            terraformDetails?.diagram?.mermaidSyntax ? (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">Diagram type: {terraformDetails?.diagram?.diagramType || "flowchart"}</p>
                <MermaidPreview syntax={String(terraformDetails.diagram.mermaidSyntax)} />
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No architecture snapshot is available for this build.</p>
            )
          )}

          {selectedStageNormalized === "cost" && (
            terraformDetails?.cost ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="rounded-md border p-3">
                  <p className="text-xs text-muted-foreground">Monthly Cost</p>
                  <p className="text-xl font-semibold">
                    {Number(terraformDetails.cost.monthlyRate || 0).toFixed(2)} {terraformDetails.cost.currency || "USD"}
                  </p>
                </div>
                <div className="rounded-md border p-3">
                  <p className="text-xs text-muted-foreground">Yearly Cost</p>
                  <p className="text-xl font-semibold">
                    {Number(terraformDetails.cost.yearlyRate || 0).toFixed(2)} {terraformDetails.cost.currency || "USD"}
                  </p>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No cost summary is available for this build.</p>
            )
          )}

          {selectedStageNormalized === "security" && (
            terraformDetails?.security ? (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="rounded-md border p-3">
                  <p className="text-xs text-muted-foreground">Pass Rate</p>
                  <p className="text-lg font-semibold">{Number(terraformDetails.security.passRate || 0).toFixed(1)}%</p>
                </div>
                <div className="rounded-md border p-3">
                  <p className="text-xs text-muted-foreground">Passed</p>
                  <p className="text-lg font-semibold">{Number(terraformDetails.security.passed || 0)}</p>
                </div>
                <div className="rounded-md border p-3">
                  <p className="text-xs text-muted-foreground">Failed</p>
                  <p className="text-lg font-semibold">{Number(terraformDetails.security.failed || 0)}</p>
                </div>
                <div className="rounded-md border p-3">
                  <p className="text-xs text-muted-foreground">Skipped</p>
                  <p className="text-lg font-semibold">{Number(terraformDetails.security.skipped || 0)}</p>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No security summary is available for this build.</p>
            )
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function History() {
  const [activeModule, setActiveModule] = useState("all");
  const [activeTab, setActiveTab] = useState<"sessions" | "builds">("sessions");
  const [, setLocation] = useLocation();

  // Sessions + activities
  const { data: historyData, isLoading: historyLoading } = useQuery<HistoryResponse>({
    queryKey: ["/api/user/history", activeModule],
    queryFn: async () => {
      const res = await apiRequest(
        "GET",
        `/api/user/history?module=${activeModule === "all" ? "" : activeModule}`
      );
      return res.json();
    },
  });

  // Build runs
  const { data: buildsData, isLoading: buildsLoading } = useQuery<{ builds: BuildRecord[]; total: number }>({
    queryKey: ["/api/builds", activeModule],
    queryFn: async () => {
      const query = new URLSearchParams({ limit: "50" });
      if (activeModule !== "all") query.set("module", activeModule);
      const res = await apiRequest("GET", `/api/builds?${query}`);
      return res.json();
    },
    enabled: activeTab === "builds",
  });

  const handleContinueSession = (session: EnrichedSession) => {
    const mod = session.inferredModule;
    const storageKey = SESSION_STORAGE_KEYS[mod];
    if (storageKey) localStorage.setItem(storageKey, session.id);
    const route = MODULE_ROUTES[mod];
    if (route) setLocation(route);
  };

  // Build session timeline
  const timelineItems: Array<
    | { type: "session"; data: EnrichedSession; date: string }
    | { type: "activity"; data: UserActivityItem; date: string }
  > = [];

  if (historyData) {
    for (const s of historyData.sessions) timelineItems.push({ type: "session", data: s, date: s.updatedAt });
    for (const a of historyData.activities) timelineItems.push({ type: "activity", data: a, date: a.createdAt });
    timelineItems.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }

  const builds = buildsData?.builds || [];

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8">

        {/* Page header */}
        <div className="flex items-center gap-3 mb-6">
          <HistoryIcon className="w-6 h-6 text-primary" />
          <h2 className="text-2xl font-bold tracking-tight">History</h2>
        </div>

        {/* View toggle: Sessions | Build Runs */}
        <div className="flex items-center gap-1 p-1 bg-muted rounded-xl mb-5 w-fit">
          {(["sessions", "builds"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-5 py-2 text-sm font-semibold rounded-lg transition-all ${
                activeTab === tab
                  ? "bg-background shadow text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {tab === "sessions" ? "Sessions & Activity" : "Build Runs"}
            </button>
          ))}
        </div>

        {/* Module filter tabs */}
        <div className="flex flex-wrap gap-2 mb-6">
          {MODULES.map((m) => (
            <Button
              key={m.key}
              variant={activeModule === m.key ? "default" : "outline"}
              size="sm"
              onClick={() => setActiveModule(m.key)}
              data-testid={`history-filter-${m.key}`}
              className="gap-1.5"
            >
              {m.key !== "all" && MODULE_ICONS[m.key]}
              {m.label}
            </Button>
          ))}
        </div>

        {/* ═══ SESSIONS TAB ════════════════════════════════════════════════════ */}
        {activeTab === "sessions" && (
          <>
            {historyLoading && (
              <div className="space-y-4">
                {[1, 2, 3, 4].map((i) => (
                  <Card key={i}>
                    <CardContent className="p-4">
                      <div className="flex items-center gap-3">
                        <Skeleton className="h-6 w-20" />
                        <Skeleton className="h-4 w-48" />
                        <Skeleton className="h-4 w-24 ml-auto" />
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}

            {!historyLoading && timelineItems.length === 0 && (
              <Card>
                <CardContent className="p-8 text-center text-muted-foreground">
                  <FolderOpen className="w-12 h-12 mx-auto mb-4 opacity-50" />
                  <p className="text-lg font-medium">No history yet</p>
                  <p className="text-sm mt-1">Start using any module to see your activity here.</p>
                </CardContent>
              </Card>
            )}

            {!historyLoading && timelineItems.length > 0 && (
              <ScrollArea className="h-[calc(100vh-320px)]">
                <div className="space-y-3 pr-4">
                  {timelineItems.map((item) => {
                    if (item.type === "session") {
                      const s = item.data;
                      const mod = s.inferredModule;
                      return (
                        <Card key={`s-${s.id}`} className="hover:shadow-md transition-shadow" data-testid={`history-session-card-${s.id}`}>
                          <CardContent className="p-4">
                            <div className="flex items-start justify-between gap-3">
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-1.5">
                                  <Badge variant="outline" className={`text-[11px] px-2 py-0.5 border flex items-center gap-1 ${MODULE_COLORS[mod] || MODULE_COLORS.unknown}`}>
                                    {MODULE_ICONS[mod] || MODULE_ICONS.unknown}
                                    <span className="ml-0.5">{mod}</span>
                                  </Badge>
                                  {s.repositoryName && (
                                    <span className="text-sm font-medium text-foreground truncate">{s.repositoryName}</span>
                                  )}
                                </div>
                                <div className="flex items-center gap-4 text-xs text-muted-foreground">
                                  <span className="flex items-center gap-1">
                                    <MessageSquare className="w-3 h-3" />{s.messageCount} messages
                                  </span>
                                  <span className="flex items-center gap-1">
                                    <FileCode className="w-3 h-3" />{s.fileCount} files
                                  </span>
                                  <span className="flex items-center gap-1" title={formatExactDate(s.updatedAt)}>
                                    <Clock className="w-3 h-3" />{timeAgo(s.updatedAt)}
                                  </span>
                                </div>
                              </div>
                              {MODULE_ROUTES[mod] && (
                                <Button variant="ghost" size="sm" onClick={() => handleContinueSession(s)} className="shrink-0" data-testid={`history-btn-continue-${s.id}`}>
                                  Continue <ArrowRight className="w-3.5 h-3.5 ml-1" />
                                </Button>
                              )}
                            </div>
                          </CardContent>
                        </Card>
                      );
                    }

                    const a = item.data;
                    return (
                      <Card key={`a-${a.id}`} className="hover:shadow-md transition-shadow">
                        <CardContent className="p-4">
                          <div className="flex items-start gap-3">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 mb-1.5">
                                <Badge variant="outline" className={`text-[11px] px-2 py-0.5 border flex items-center gap-1 ${MODULE_COLORS[a.module] || MODULE_COLORS.unknown}`}>
                                  {MODULE_ICONS[a.module] || MODULE_ICONS.unknown}
                                  <span className="ml-0.5">{a.module}</span>
                                </Badge>
                                <span className="text-sm font-medium truncate">{a.actionLabel}</span>
                              </div>
                              <div className="flex items-center gap-1 text-xs text-muted-foreground" title={formatExactDate(a.createdAt)}>
                                <Clock className="w-3 h-3" />{timeAgo(a.createdAt)}
                              </div>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              </ScrollArea>
            )}
          </>
        )}

        {/* ═══ BUILD RUNS TAB ══════════════════════════════════════════════════ */}
        {activeTab === "builds" && (
          <>
            {buildsLoading && (
              <div className="space-y-4">
                {[1, 2, 3].map((i) => (
                  <Card key={i}>
                    <CardContent className="p-4 space-y-2">
                      <div className="flex items-center gap-3">
                        <Skeleton className="h-5 w-40" />
                        <Skeleton className="h-6 w-24" />
                        <Skeleton className="h-6 w-20" />
                      </div>
                      <div className="flex gap-2">
                        <Skeleton className="h-5 w-28" />
                        <Skeleton className="h-5 w-28" />
                        <Skeleton className="h-5 w-28" />
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}

            {!buildsLoading && builds.length === 0 && (
              <Card>
                <CardContent className="p-10 text-center text-muted-foreground">
                  <PlayCircle className="w-12 h-12 mx-auto mb-4 opacity-40" />
                  <p className="text-lg font-medium">No build runs yet</p>
                  <p className="text-sm mt-1">
                    Run the Build Pipeline in any module to create a build record here.
                  </p>
                </CardContent>
              </Card>
            )}

            {!buildsLoading && builds.length > 0 && (
              <>
                {/* Summary bar */}
                <div className="flex flex-wrap items-center gap-6 mb-4 px-1 text-sm text-muted-foreground">
                  <span className="font-medium text-foreground">{builds.length} build run{builds.length !== 1 ? "s" : ""}</span>
                  <span className="flex items-center gap-1.5">
                    <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                    {builds.filter(b => b.status === "completed").length} completed
                  </span>
                  {builds.filter(b => b.status === "failed").length > 0 && (
                    <span className="flex items-center gap-1.5">
                      <XCircle className="w-4 h-4 text-rose-500" />
                      {builds.filter(b => b.status === "failed").length} failed
                    </span>
                  )}
                  {builds[0] && (
                    <span className="flex items-center gap-1.5">
                      <Clock className="w-4 h-4" />
                      Last run: {timeAgo(builds[0].createdAt)}
                    </span>
                  )}
                </div>

                <ScrollArea className="h-[calc(100vh-360px)]">
                  <div className="space-y-3 pr-4">
                    {builds.map((build) => (
                      <BuildRunCard key={build.id} build={build} />
                    ))}
                  </div>
                </ScrollArea>
              </>
            )}
          </>
        )}

      </main>
    </div>
  );
}
