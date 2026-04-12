import { useState, useEffect } from "react";
import { Clock, CheckCircle2, XCircle, Loader2, History, ChevronDown, ChevronRight, GitBranch, FileCode, Timer, Layers } from "lucide-react";
import { fetchBuildHistory } from "@/lib/build-history";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import mermaid from "mermaid";

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

interface BuildHistoryPanelProps {
  /** Filter by session — omit to show all user builds */
  sessionId?: string;
  module?: string;
  /** Max number of builds to show */
  limit?: number;
  /** Compact mode for sidebar embedding */
  compact?: boolean;
  /** Pass buildId or any changing value to trigger a re-fetch */
  refreshKey?: string | null;
  /** Show module badge on each build (useful when showing all modules) */
  showModuleBadge?: boolean;
  /** Title override */
  title?: string;
}

export const MODULE_COLORS: Record<string, string> = {
  terraform: 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300',
  kubernetes: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  docker: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-300',
  archme: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  helm: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300',
  automation: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300',
};

function formatTime(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHrs = Math.floor(diffMin / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  const diffDays = Math.floor(diffHrs / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
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
  const s = String(stage || '').toLowerCase();
  if (s.includes('diagram') || s.includes('architecture')) return 'diagram';
  if (s.includes('cost')) return 'cost';
  if (s.includes('security') || s.includes('scan')) return 'security';
  if (s.includes('refactor') || s.includes('best')) return 'refactor';
  return s;
}

function getStageLabel(stage: string): string {
  const normalized = normalizeStage(stage);
  if (normalized === 'diagram') return 'Architecture';
  if (normalized === 'cost') return 'Cost Analysis';
  if (normalized === 'security') return 'Security Scan';
  if (normalized === 'refactor') return 'Best Approach';
  return stage;
}

function getTerraformBuildDetails(metadata?: Record<string, any> | null) {
  if (!metadata || typeof metadata !== 'object') return null;
  return metadata.terraformBuildDetails || metadata;
}

function MermaidPreview({ syntax }: { syntax: string }) {
  const [error, setError] = useState<string | null>(null);
  const [svg, setSvg] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    const render = async () => {
      try {
        mermaid.initialize({
          startOnLoad: false,
          theme: "default",
          securityLevel: "strict",
          flowchart: { useMaxWidth: true, htmlLabels: false, curve: "basis" },
        });
        const { svg: rendered } = await mermaid.render(`history-mermaid-${Date.now()}`, syntax.trim());
        if (!cancelled) {
          setSvg(rendered);
          setError(null);
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(err?.message || "Unable to render diagram");
        }
      }
    };
    if (syntax?.trim()) {
      void render();
    }
    return () => {
      cancelled = true;
    };
  }, [syntax]);

  if (error) {
    return <p className="text-sm text-rose-600">Unable to render architecture diagram: {error}</p>;
  }

  if (!svg) {
    return <p className="text-sm text-muted-foreground">Rendering architecture diagram...</p>;
  }

  return (
    <div className="max-h-[72vh] overflow-auto rounded-md border bg-white p-3">
      <div className="min-w-[980px]" dangerouslySetInnerHTML={{ __html: svg }} />
    </div>
  );
}

function BuildCard({ build, showModule, defaultExpanded }: { build: BuildRecord; showModule: boolean; defaultExpanded?: boolean }) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded || false);
  const [detailStage, setDetailStage] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const details = getTerraformBuildDetails(build.metadata);
  const activeStage = normalizeStage(detailStage || '');
  const canOpenStageDetail = (stage: string) =>
    build.module === 'terraform' && ['diagram', 'cost', 'security'].includes(normalizeStage(stage));

  const statusIcon = build.status === 'completed'
    ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
    : build.status === 'failed'
      ? <XCircle className="w-3.5 h-3.5 text-rose-500" />
      : <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-500" />;

  return (
    <div className="rounded-lg border bg-card overflow-hidden">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left hover:bg-muted/50 transition-colors"
      >
        {statusIcon}
        <span className="font-mono text-xs font-medium truncate">{build.buildId}</span>
        <span className="flex-1" />
        {showModule && (
          <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${MODULE_COLORS[build.module] || 'bg-gray-100 text-gray-600'}`}>
            {build.module}
          </span>
        )}
        <span className="text-[10px] text-muted-foreground whitespace-nowrap">{formatTime(build.createdAt)}</span>
        {isExpanded ? <ChevronDown className="w-3 h-3 text-muted-foreground" /> : <ChevronRight className="w-3 h-3 text-muted-foreground" />}
      </button>

      {isExpanded && (
        <div className="px-3 pb-3 pt-1 border-t bg-muted/30 space-y-2">
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
            <div className="flex items-center gap-1.5">
              <span className="text-muted-foreground">Status:</span>
              <span className={build.status === 'completed' ? 'text-emerald-600 font-medium' : build.status === 'failed' ? 'text-rose-600 font-medium' : 'text-blue-600 font-medium'}>
                {build.status}
              </span>
            </div>
            {build.filesGenerated != null && (
              <div className="flex items-center gap-1.5">
                <FileCode className="w-3 h-3 text-muted-foreground" />
                <span>{build.filesGenerated} files</span>
              </div>
            )}
            {build.repositoryName && (
              <div className="col-span-2 flex items-center gap-1.5">
                <GitBranch className="w-3 h-3 text-muted-foreground" />
                <span>{build.repositoryName}</span>
                {build.repositoryBranch && <span className="opacity-60">({build.repositoryBranch})</span>}
              </div>
            )}
            {build.totalDurationMs != null && (
              <div className="flex items-center gap-1.5">
                <Timer className="w-3 h-3 text-muted-foreground" />
                <span>{formatDuration(build.totalDurationMs)}</span>
              </div>
            )}
            {showModule && (
              <div className="flex items-center gap-1.5">
                <Layers className="w-3 h-3 text-muted-foreground" />
                <span className="capitalize">{build.module}</span>
              </div>
            )}
          </div>

          {/* Pipeline stages */}
          {build.pipelineStages && build.pipelineStages.length > 0 && (
            <div>
              <p className="text-[10px] text-muted-foreground mb-1 uppercase tracking-wider">Pipeline Stages</p>
              <div className="flex gap-1 flex-wrap">
                {build.pipelineStages.map((stage, i) => (
                  canOpenStageDetail(stage) ? (
                    <button
                      key={i}
                      type="button"
                      onClick={() => {
                        setDetailStage(stage);
                        setDetailOpen(true);
                      }}
                      className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-muted border hover:bg-accent transition-colors"
                      title="Click to view stage details"
                    >
                      <CheckCircle2 className="w-2.5 h-2.5 text-emerald-500" />
                      {getStageLabel(stage)}
                    </button>
                  ) : (
                    <span key={i} className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-muted border">
                      <CheckCircle2 className="w-2.5 h-2.5 text-emerald-500" />
                      {getStageLabel(stage)}
                    </span>
                  )
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className={activeStage === 'diagram' ? "max-w-[95vw] w-[95vw]" : "max-w-3xl"}>
          <DialogHeader>
            <DialogTitle>{getStageLabel(detailStage || 'Stage Detail')} — {build.buildId}</DialogTitle>
            <DialogDescription>
              Terraform build stage insights captured at completion time.
            </DialogDescription>
          </DialogHeader>

          {activeStage === 'diagram' && (
            details?.diagram?.mermaidSyntax ? (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  Diagram type: {details?.diagram?.diagramType || 'flowchart'}
                </p>
                <MermaidPreview syntax={String(details.diagram.mermaidSyntax)} />
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No architecture snapshot is available for this build.</p>
            )
          )}

          {activeStage === 'cost' && (
            details?.cost ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="rounded-md border p-3">
                  <p className="text-xs text-muted-foreground">Monthly Cost</p>
                  <p className="text-xl font-semibold">
                    {Number(details.cost.monthlyRate || 0).toFixed(2)} {details.cost.currency || 'USD'}
                  </p>
                </div>
                <div className="rounded-md border p-3">
                  <p className="text-xs text-muted-foreground">Yearly Cost</p>
                  <p className="text-xl font-semibold">
                    {Number(details.cost.yearlyRate || 0).toFixed(2)} {details.cost.currency || 'USD'}
                  </p>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No cost summary is available for this build.</p>
            )
          )}

          {activeStage === 'security' && (
            details?.security ? (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="rounded-md border p-3">
                  <p className="text-xs text-muted-foreground">Pass Rate</p>
                  <p className="text-lg font-semibold">{Number(details.security.passRate || 0).toFixed(1)}%</p>
                </div>
                <div className="rounded-md border p-3">
                  <p className="text-xs text-muted-foreground">Passed</p>
                  <p className="text-lg font-semibold">{Number(details.security.passed || 0)}</p>
                </div>
                <div className="rounded-md border p-3">
                  <p className="text-xs text-muted-foreground">Failed</p>
                  <p className="text-lg font-semibold">{Number(details.security.failed || 0)}</p>
                </div>
                <div className="rounded-md border p-3">
                  <p className="text-xs text-muted-foreground">Skipped</p>
                  <p className="text-lg font-semibold">{Number(details.security.skipped || 0)}</p>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No security summary is available for this build.</p>
            )
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function BuildHistoryPanel({
  sessionId,
  module,
  limit = 10,
  compact = false,
  refreshKey,
  showModuleBadge,
  title,
}: BuildHistoryPanelProps) {
  const [builds, setBuilds] = useState<BuildRecord[]>([]);
  const [loading, setLoading] = useState(true);

  // Show module badge when not filtering by single module or explicitly requested
  const showModule = showModuleBadge ?? !module;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchBuildHistory({ sessionId, module, limit }).then((data) => {
      if (!cancelled) {
        setBuilds(data.builds || []);
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [sessionId, module, limit, refreshKey]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading build history...
      </div>
    );
  }

  if (builds.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 p-6 text-center text-muted-foreground">
        <History className="w-8 h-8 opacity-40" />
        <p className="text-sm">No build history yet</p>
        <p className="text-xs opacity-70">Run the build pipeline to create your first build record</p>
      </div>
    );
  }

  return (
    <div className={compact ? "space-y-1" : "space-y-2"}>
      {!compact && (
        <div className="flex items-center gap-2 px-1 mb-3">
          <History className="w-4 h-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">{title || 'Build History'}</h3>
          <span className="text-xs text-muted-foreground ml-auto">{builds.length} build{builds.length !== 1 ? 's' : ''}</span>
        </div>
      )}

      {builds.map((build, idx) => (
        <BuildCard
          key={build.id}
          build={build}
          showModule={showModule}
          defaultExpanded={idx === 0 && !compact}
        />
      ))}
    </div>
  );
}
