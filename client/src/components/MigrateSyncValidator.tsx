import { useEffect, useState } from "react";
import { Loader2, RefreshCw, ShieldAlert, CheckCircle2, AlertTriangle, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { apiRequest } from "@/lib/queryClient";

interface SyncCheckResponse {
  summary: {
    status: "in_sync" | "out_of_sync";
    terraformResourceCount: number;
    importBlockCount: number;
    missingImportCount: number;
    staleImportCount: number;
    orphanImportCount: number;
  };
  details: {
    missingImports: string[];
    staleImports: Array<{ to: string; id: string }>;
    orphanImports: string[];
  };
  warnings: string[];
  aiRemediation?: {
    summary: string;
    suggestions: Array<{
      category: "missing_import" | "stale_import_id" | "orphan_import";
      title: string;
      detail: string;
      suggestedFix: string;
    }>;
  } | null;
}

function categoryLabel(cat: string): string {
  switch (cat) {
    case "missing_import":
      return "Missing import";
    case "stale_import_id":
      return "Stale import ID";
    case "orphan_import":
      return "Orphan import";
    default:
      return cat;
  }
}

const PREVIEW_EACH = 2;

function DriftStatusBanner({ result }: { result: SyncCheckResponse }) {
  const s = result.summary;
  const d = result.details;
  const parts: string[] = [];
  if (s.missingImportCount > 0) {
    parts.push(`${s.missingImportCount} missing import${s.missingImportCount === 1 ? "" : "s"}`);
  }
  if (s.staleImportCount > 0) {
    parts.push(`${s.staleImportCount} stale import ID${s.staleImportCount === 1 ? "" : "s"}`);
  }
  if (s.orphanImportCount > 0) {
    parts.push(`${s.orphanImportCount} orphan import${s.orphanImportCount === 1 ? "" : "s"}`);
  }
  const summaryLine = parts.length > 0 ? parts.join(" · ") : "Drift detected";

  return (
    <div className="flex-1 min-w-0 space-y-2">
      <p className="font-medium leading-snug">Out of sync — review before apply</p>
      <p className="text-xs leading-relaxed">
        <span className="font-semibold">What drifted: </span>
        {summaryLine}. Terraform resources, <code className="rounded bg-orange-100/80 dark:bg-orange-950/40 px-1">imports.tf</code> import blocks, and the last scanned Azure resource IDs must line up.
      </p>
      <ul className="list-disc pl-4 space-y-0.5 text-xs leading-relaxed">
        {s.missingImportCount > 0 && (
          <li>
            <strong>Missing imports:</strong> resource block exists in main/root module but no matching{" "}
            <code className="rounded bg-orange-100/80 dark:bg-orange-950/40 px-0.5">import</code> with the same{" "}
            <code className="rounded bg-orange-100/80 dark:bg-orange-950/40 px-0.5">to</code> address.
          </li>
        )}
        {s.staleImportCount > 0 && (
          <li>
            <strong>Stale IDs:</strong> an import block&apos;s <code className="rounded bg-orange-100/80 dark:bg-orange-950/40 px-0.5">id</code> is not among IDs from the last Azure scan (subscription moved, resource recreated, or scan is old).
          </li>
        )}
        {s.orphanImportCount > 0 && (
          <li>
            <strong>Orphan imports:</strong> <code className="rounded bg-orange-100/80 dark:bg-orange-950/40 px-0.5">to</code> in imports.tf does not match any resource block in the current module.
          </li>
        )}
      </ul>

      {(d.missingImports.length > 0 || d.staleImports.length > 0 || d.orphanImports.length > 0) && (
        <div className="rounded border border-orange-200/70 bg-white/40 dark:bg-orange-950/20 px-2 py-2 space-y-2 text-[11px]">
          <p className="font-sans text-xs font-medium text-orange-950 dark:text-orange-100">Preview (full lists below)</p>
          {d.missingImports.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">Missing addresses</div>
              <ul className="font-mono text-orange-950 dark:text-orange-100 break-all space-y-0.5">
                {d.missingImports.slice(0, PREVIEW_EACH).map((addr) => (
                  <li key={addr}>{addr}</li>
                ))}
              </ul>
              {d.missingImports.length > PREVIEW_EACH && (
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  +{d.missingImports.length - PREVIEW_EACH} more in &quot;Missing import blocks&quot;
                </p>
              )}
            </div>
          )}
          {d.staleImports.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">Stale import id / to</div>
              <ul className="space-y-1.5">
                {d.staleImports.slice(0, PREVIEW_EACH).map((row, idx) => (
                  <li key={`${row.to}-${idx}`} className="font-mono break-all text-orange-950 dark:text-orange-100">
                    <span className="text-muted-foreground">to</span> = {row.to}{" "}
                    <span className="text-muted-foreground">· id</span> = {row.id}
                  </li>
                ))}
              </ul>
              {d.staleImports.length > PREVIEW_EACH && (
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  +{d.staleImports.length - PREVIEW_EACH} more in &quot;Stale import IDs&quot;
                </p>
              )}
            </div>
          )}
          {d.orphanImports.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">Orphan to addresses</div>
              <ul className="font-mono text-orange-950 dark:text-orange-100 break-all space-y-0.5">
                {d.orphanImports.slice(0, PREVIEW_EACH).map((addr) => (
                  <li key={addr}>{addr}</li>
                ))}
              </ul>
              {d.orphanImports.length > PREVIEW_EACH && (
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  +{d.orphanImports.length - PREVIEW_EACH} more in &quot;Orphan import blocks&quot;
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {result.aiRemediation ? (
        <p className="text-xs leading-relaxed border-t border-orange-300/50 pt-2 text-orange-900/90 dark:text-orange-200/90">
          <strong>Next:</strong> read the <strong>AI guidance</strong> section below for a plain-language summary and suggested fixes per issue.
        </p>
      ) : (
        <p className="text-xs leading-relaxed border-t border-orange-300/50 pt-2 text-orange-900/90 dark:text-orange-200/90">
          <strong>No AI guidance this run.</strong> The server can generate step-by-step fixes when{" "}
          <code className="rounded bg-orange-100/80 dark:bg-orange-950/40 px-1">MIGRATEOPS_SYNC_AI</code> is not set to{" "}
          <code className="rounded bg-orange-100/80 dark:bg-orange-950/40 px-1">0</code> and the OpenAI integration is configured. Use the sections below for the full list of addresses and IDs.
        </p>
      )}
    </div>
  );
}

interface MigrateSyncValidatorProps {
  sessionId: string;
  autoRunSignal?: number;
  onRunStateChange?: (state: "running" | "done" | "error", result?: SyncCheckResponse) => void;
  onComplete?: (result: SyncCheckResponse) => void;
}

const MigrateSyncValidator = ({ sessionId, autoRunSignal = 0, onRunStateChange, onComplete }: MigrateSyncValidatorProps) => {
    const [isRunning, setIsRunning] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [result, setResult] = useState<SyncCheckResponse | null>(null);

    const runSyncCheck = async () => {
      if (!sessionId || isRunning) return;
      try {
        setIsRunning(true);
        setError(null);
        onRunStateChange?.("running");
        const res = await apiRequest("POST", "/api/migrate/sync-check", { sessionId });
        const contentType = (res.headers.get("content-type") || "").toLowerCase();
        if (!contentType.includes("application/json")) {
          const body = await res.text();
          const preview = body.trim().slice(0, 120).replace(/\s+/g, " ");
          throw new Error(
            `Sync endpoint returned non-JSON response (${contentType || "unknown"}). Preview: ${preview}`
          );
        }

        const data = (await res.json()) as SyncCheckResponse;
        setResult(data);
        onRunStateChange?.("done", data);
        onComplete?.(data);
      } catch (err: any) {
        const message = err?.message || "Sync validation failed";
        setError(message);
        onRunStateChange?.("error");
      } finally {
        setIsRunning(false);
      }
    };

    useEffect(() => {
      if (autoRunSignal > 0) {
        void runSyncCheck();
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoRunSignal]);

    return (
      <Card className="border-muted/50">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <RefreshCw className="w-4 h-4" />
            Sync Validation
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="text-sm text-muted-foreground">
            Confirms Terraform resources/import mappings stay aligned with scanned Azure resources. Any drift can trigger resource replacement.
          </div>

          <div className="rounded-md border bg-amber-50 border-amber-200 text-amber-900 p-3 text-sm flex items-start gap-2">
            <ShieldAlert className="w-4 h-4 mt-0.5 shrink-0" />
            <span>Strict mode: even a small configuration change may result in delete/recreate behavior.</span>
          </div>

          <Button onClick={runSyncCheck} disabled={isRunning || !sessionId}>
            {isRunning ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Running Sync Check...
              </>
            ) : (
              <>
                <RefreshCw className="w-4 h-4 mr-2" />
                Run Sync Check
              </>
            )}
          </Button>

          {error && (
            <div className="rounded-md border border-red-200 bg-red-50 text-red-700 p-3 text-sm">
              {error}
            </div>
          )}

          {result && (
            <div className="space-y-3">
              <div
                className={`rounded-md border p-3 text-sm flex items-start gap-2 ${
                  result.summary.status === "in_sync"
                    ? "border-green-200 bg-green-50 text-green-800"
                    : "border-orange-200 bg-orange-50 text-orange-800 dark:border-orange-900/60 dark:bg-orange-950/40 dark:text-orange-100"
                }`}
              >
                {result.summary.status === "in_sync" ? (
                  <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
                ) : (
                  <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                )}
                {result.summary.status === "in_sync" ? (
                  <span>Terraform and import mapping are currently aligned.</span>
                ) : (
                  <DriftStatusBanner result={result} />
                )}
              </div>

              <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-xs">
                <div className="rounded-md border p-2">Resources: {result.summary.terraformResourceCount}</div>
                <div className="rounded-md border p-2">Imports: {result.summary.importBlockCount}</div>
                <div className="rounded-md border p-2">Missing Imports: {result.summary.missingImportCount}</div>
                <div className="rounded-md border p-2">Stale IDs: {result.summary.staleImportCount}</div>
                <div className="rounded-md border p-2">Orphan Imports: {result.summary.orphanImportCount}</div>
              </div>

              {result.summary.status === "out_of_sync" && (
                <div className="space-y-2 text-sm">
                  {result.details.missingImports.length > 0 && (
                    <details
                      className="rounded-md border border-orange-200/80 bg-orange-50/40 p-3"
                      open
                    >
                      <summary className="cursor-pointer font-medium text-orange-950 select-none">
                        Missing import blocks ({result.details.missingImports.length})
                      </summary>
                      <p className="mt-2 text-xs text-muted-foreground">
                        Add an <code className="rounded bg-muted px-1">import</code> block for each address so Terraform state can adopt existing Azure resources.
                      </p>
                      <ul className="mt-2 max-h-52 overflow-y-auto space-y-1.5 pl-1 font-mono text-[11px] text-orange-950 break-all border-t border-orange-200/50 pt-2">
                        {result.details.missingImports.map((addr) => (
                          <li key={addr}>{addr}</li>
                        ))}
                      </ul>
                    </details>
                  )}

                  {result.details.staleImports.length > 0 && (
                    <details
                      className="rounded-md border border-orange-200/80 bg-orange-50/40 p-3"
                      open
                    >
                      <summary className="cursor-pointer font-medium text-orange-950 select-none">
                        Stale import IDs ({result.details.staleImports.length})
                      </summary>
                      <p className="mt-2 text-xs text-muted-foreground">
                        These import <code className="rounded bg-muted px-1">id</code> values were not found among scanned Azure resource IDs. Re-run discovery / extract or update IDs after Azure changes.
                      </p>
                      <ul className="mt-2 max-h-60 overflow-y-auto space-y-3 border-t border-orange-200/50 pt-2">
                        {result.details.staleImports.map((row, idx) => (
                          <li key={`${row.to}-${idx}`} className="text-[11px] space-y-1">
                            <div className="font-mono text-orange-950 break-all">
                              <span className="text-muted-foreground">to</span> = {row.to}
                            </div>
                            <div className="font-mono text-orange-900/90 break-all pl-2 border-l-2 border-orange-300/80">
                              <span className="text-muted-foreground">id</span> = {row.id}
                            </div>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}

                  {result.details.orphanImports.length > 0 && (
                    <details
                      className="rounded-md border border-orange-200/80 bg-orange-50/40 p-3"
                      open
                    >
                      <summary className="cursor-pointer font-medium text-orange-950 select-none">
                        Orphan import blocks ({result.details.orphanImports.length})
                      </summary>
                      <p className="mt-2 text-xs text-muted-foreground">
                        These <code className="rounded bg-muted px-1">to</code> addresses appear in imports.tf but not as resource blocks in main.tf. Remove the import or restore the matching resource.
                      </p>
                      <ul className="mt-2 max-h-52 overflow-y-auto space-y-1.5 pl-1 font-mono text-[11px] text-orange-950 break-all border-t border-orange-200/50 pt-2">
                        {result.details.orphanImports.map((addr) => (
                          <li key={addr}>{addr}</li>
                        ))}
                      </ul>
                    </details>
                  )}

                  {result.aiRemediation && (
                    <div className="rounded-md border border-violet-200 bg-violet-50/60 p-3 space-y-3">
                      <div className="flex items-center gap-2 text-violet-950 font-medium text-sm">
                        <Sparkles className="w-4 h-4 shrink-0" />
                        AI guidance
                      </div>
                      <p className="text-sm text-violet-950/95 leading-relaxed whitespace-pre-wrap">
                        {result.aiRemediation.summary}
                      </p>
                      {result.aiRemediation.suggestions.length > 0 && (
                        <ul className="space-y-3">
                          {result.aiRemediation.suggestions.map((s, i) => (
                            <li
                              key={i}
                              className="rounded-md border border-violet-200/80 bg-background/80 p-3 text-xs space-y-1.5"
                            >
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-medium text-foreground">{s.title}</span>
                                <Badge variant="secondary" className="text-[10px] font-normal">
                                  {categoryLabel(s.category)}
                                </Badge>
                              </div>
                              {s.detail ? (
                                <p className="text-muted-foreground leading-relaxed">{s.detail}</p>
                              ) : null}
                              {s.suggestedFix ? (
                                <p className="text-foreground/90 leading-relaxed">
                                  <span className="font-medium text-violet-900/90">Suggested fix: </span>
                                  {s.suggestedFix}
                                </p>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              )}

              {result.warnings?.length > 0 && (
                <div className="rounded-md border bg-muted/40 p-3 text-xs space-y-1">
                  {result.warnings.map((w, idx) => (
                    <div key={idx}>- {w}</div>
                  ))}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    );
};

export default MigrateSyncValidator;
