import { useState, useRef, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Shield, DollarSign, Wrench, Loader2, Network, PlayCircle, CheckCircle2, Activity, ChevronRight, RefreshCw } from "lucide-react";
import CheckovScanner, { CheckovScannerRef } from "./CheckovScanner";
import CostAnalyzer, { CostAnalyzerRef } from "./CostAnalyzer";
import KubernetesCostEstimator, { KubernetesCostEstimatorRef } from "./KubernetesCostEstimator";
import RefactorValidator, { RefactorValidatorRef } from "./RefactorValidator";
import ArchitectureDiagram, { ArchitectureDiagramRef } from "./ArchitectureDiagram";
import KubernetesValidator, { KubernetesValidatorRef } from "./KubernetesValidator";
import DockerBestPractices, { DockerBestPracticesRef } from "./DockerBestPractices";
import MigrateSyncValidator from "./MigrateSyncValidator";

export interface ActivityPanelProps {
  sessionId: string;
  onScanComplete?: (result?: any) => void;
  onFixesApproved?: () => void;
  workflowType?: 'terraform' | 'kubernetes' | 'docker' | 'archme' | 'migrateops' | 'automation' | 'scoreme';
  moduleApproach?: 'child-module' | 'standalone-root' | 'aggregated-root' | null;
  checkovFramework?: 'terraform' | 'kubernetes' | 'docker';
  /** When true, automatically runs all pipeline stages in sequence on mount */
  autoRun?: boolean;
  /** Called after every stage in the pipeline completes (stage name + index) */
  onPipelineStageComplete?: (stage: string, index: number, total: number) => void;
  /** Called when all pipeline stages have finished */
  onPipelineComplete?: () => void;
  /** Render as dark sidebar + content layout (used by K8s Build tab) */
  pipelineLayout?: 'default' | 'sidebar';
  /** Called when user clicks "Run Pipeline" in sidebar layout */
  onRequestRunPipeline?: () => void;
  /** Called with the raw diagram result when the diagram stage completes */
  onDiagramResult?: (result: any) => void;
  /** Called with raw scan result when security stage completes (in addition to onScanComplete) */
  onScanResult?: (result: any) => void;
  /** Called with raw cost result when cost stage completes */
  onCostResult?: (result: any) => void;
  /** Called when user clicks "View Build Summary" after all stages complete (replaces auto-navigate) */
  onViewBuildSummary?: () => void;
  /** After applying a cost rightsizing suggestion to session .tf files (Terraform / MigrateOps cost stage) */
  onTerraformFilesChanged?: () => void;
  onUpdateFiles?: (newFiles: any) => void;
  generatedFiles?: any[];
}

const STAGE_INFO: Record<string, { label: string; icon: React.ComponentType<any> }> = {
  security: { label: 'Security Scan',    icon: Shield },
  validate: { label: 'Best Practices',   icon: Wrench },
  cost:     { label: 'Cost Analysis',    icon: DollarSign },
  diagram:  { label: 'Architecture',     icon: Network },
  refactor: { label: 'Best Approach',    icon: Wrench },
  sync:     { label: 'Sync',             icon: RefreshCw },
};

type Activity = 'security' | 'cost' | 'refactor' | 'diagram' | 'validate' | 'sync';
type RunningActivity = Activity | null;

export default function ActivityPanel({ sessionId, onScanComplete, onFixesApproved, workflowType = 'terraform', moduleApproach = null, checkovFramework, autoRun = false, onPipelineStageComplete, onPipelineComplete, pipelineLayout = 'default', onRequestRunPipeline, onDiagramResult, onScanResult, onCostResult, onViewBuildSummary, onTerraformFilesChanged }: ActivityPanelProps) {
  const [runningActivity, setRunningActivity] = useState<RunningActivity>(null);
  const [activeView, setActiveView] = useState<RunningActivity>(null);
  // Track which activities have completed at least once - don't re-trigger on view switch
  const [completedActivities, setCompletedActivities] = useState<Set<Activity>>(new Set());
  const [shouldTriggerScan, setShouldTriggerScan] = useState(false);
  // Pipeline state
  const pipelineQueueRef = useRef<Activity[]>([]);
  const pipelineActiveRef = useRef(false);
  const pipelineStartedRef = useRef(false);
  /** K8s sidebar: after Best Practices fix+approve, auto-advance to Security instead of pausing again */
  const skipNextSidebarPauseRef = useRef(false);
  const [internalPipelineRunning, setInternalPipelineRunning] = useState(false);
  // Sidebar approval state: next stage waiting for user approval, or 'done' when all finished
  const [pendingNextStage, setPendingNextStage] = useState<Activity | null>(null);
  const [buildFinishPending, setBuildFinishPending] = useState(false);
  // Terminal console log lines shown while a stage is running
  const [terminalLines, setTerminalLines] = useState<string[]>([]);
  const terminalTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const [shouldTriggerCost, setShouldTriggerCost] = useState(false);
  const [shouldTriggerRefactor, setShouldTriggerRefactor] = useState(false);
  const [shouldTriggerDiagram, setShouldTriggerDiagram] = useState(false);
  const [shouldTriggerValidate, setShouldTriggerValidate] = useState(false);
  const [syncRunSignal, setSyncRunSignal] = useState(0);
  const [isFixing, setIsFixing] = useState(false);
  // Security scan completed with failures — user must fix/approve before pipeline advances
  const [securityPendingCompletion, setSecurityPendingCompletion] = useState(false);
  // Track how many security scans have completed (max 2: initial + 1 re-scan after fix)
  const securityScanCountRef = useRef(0);
  // Active fix operation: 'refactor' | 'security' | null — shows the terminal during fix
  const [fixingActivity, setFixingActivity] = useState<Activity | null>(null);
  const checkovRef = useRef<CheckovScannerRef>(null);
  const costRef = useRef<CostAnalyzerRef>(null);
  const k8sCostRef = useRef<KubernetesCostEstimatorRef>(null);
  const refactorRef = useRef<RefactorValidatorRef>(null);
  const diagramRef = useRef<ArchitectureDiagramRef>(null);
  const kubernetesValidatorRef = useRef<KubernetesValidatorRef>(null);
  const dockerBestPracticesRef = useRef<DockerBestPracticesRef>(null);

  // ── Terminal log lines per stage ─────────────────────────────────────────
  const isTerraform = workflowType === 'terraform' || workflowType === 'migrateops';
  const isDocker = workflowType === 'docker';
  const STAGE_LOGS: Record<string, string[]> = {
    diagram: [
      '$ Generating architecture diagram...',
      isTerraform ? '  → Parsing Terraform resource graph' : isDocker ? '  → Parsing Docker Compose services' : '  → Parsing Kubernetes manifests',
      '  → Detecting resource kinds',
      '  → Mapping service relationships',
      isTerraform ? '  → Resolving module dependencies' : '  → Resolving ingress routes',
      '  → Building node graph',
      '  → Laying out diagram',
      '  → Rendering architecture...',
    ],
    validate: [
      isTerraform ? '$ Analysing Terraform configuration...' : isDocker ? '$ Analysing Dockerfile...' : '$ Analysing Kubernetes manifests...',
      '  → Loading YAML files',
      '  → Running schema validation',
      isTerraform ? '  → Checking provider version constraints' : '  → Checking apiVersion compatibility',
      '  → Evaluating resource configurations',
      '  → Analysing best practices',
      '  → Checking security context',
      '  → Evaluating probe configurations',
    ],
    security: [
      '$ Initialising security scanner...',
      isTerraform ? '  → Loading Terraform state files' : isDocker ? '  → Loading Dockerfile layers' : '  → Loading Kubernetes resources',
      isTerraform ? '  → Running Checkov policy checks' : '  → Checking privilege escalation rules',
      isTerraform ? '  → Scanning IAM and network rules' : '  → Scanning container security contexts',
      isTerraform ? '  → Validating encryption settings' : '  → Validating RBAC policies',
      isTerraform ? '  → Checking public exposure rules' : '  → Checking host namespace isolation',
      '  → Analysing image policies',
      '  → Evaluating resource limits',
    ],
    refactor: [
      '$ Running best approach analysis...',
      '  → Loading configuration',
      '  → Analysing structure',
      '  → Checking patterns',
    ],
    cost: [
      '$ Parsing resource specifications...',
      isTerraform ? '  → Reading Terraform resource definitions' : '  → Reading CPU/memory requests',
      '  → Fetching cloud pricing data',
      isTerraform ? '  → Calculating infrastructure costs' : '  → Calculating container costs',
    ],
    sync: [
      '$ Running strict sync validation...',
      '  → Reading Terraform resource blocks',
      '  → Reading import mapping',
      '  → Comparing imported Azure IDs',
      '  → Evaluating drift risk',
      '  → Finalizing sync report',
    ],
  };

  // ── Terminal log lines while a FIX is running ────────────────────────────
  const STAGE_FIX_LOGS: Record<string, string[]> = {
    refactor: [
      '$ Applying best-approach fixes...',
      '  → Reading Terraform source files',
      '  → Extracting hardcoded values into variables',
      '  → Updating variable declarations',
      '  → Applying resource naming conventions',
      '  → Fixing missing tfvars entries',
      '  → Re-validating patched files',
      '  ✓ Fixes written — re-scanning...',
    ],
    security: [
      '$ Applying security remediations...',
      '  → Loading selected failed checks',
      '  → Analysing fix strategies',
      '  → Patching resource configurations',
      '  → Disabling privilege escalation',
      '  → Enforcing read-only root filesystem',
      '  → Dropping unnecessary capabilities',
      '  → Writing patched files',
      '  ✓ Patches applied — reviewing diffs...',
    ],
    validate: [
      '$ Applying best-practice fixes...',
      '  → Loading Kubernetes manifests',
      '  → Analysing resource configurations',
      '  → Adding security contexts',
      '  → Setting resource limits',
      '  → Configuring health probes',
      '  → Writing patched files',
      '  ✓ Fixes written — re-validating...',
    ],
  };

  // Drive terminal log lines while a stage is running OR a fix is in progress
  useEffect(() => {
    terminalTimersRef.current.forEach(t => clearTimeout(t));
    terminalTimersRef.current = [];

    if (pipelineLayout !== 'sidebar') return;

    const activeForTerminal = runningActivity ?? fixingActivity;
    if (!activeForTerminal) return;

    const lines = fixingActivity
      ? (STAGE_FIX_LOGS[fixingActivity] ?? [`$ Applying fixes for ${fixingActivity}...`])
      : (STAGE_LOGS[activeForTerminal] ?? [`$ Running ${activeForTerminal}...`]);

    setTerminalLines([]);

    lines.forEach((line, i) => {
      const t = setTimeout(() => {
        setTerminalLines(prev => [...prev, line]);
      }, i * 550);
      terminalTimersRef.current.push(t);
    });

    return () => {
      terminalTimersRef.current.forEach(t => clearTimeout(t));
      terminalTimersRef.current = [];
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningActivity, fixingActivity, pipelineLayout]);

  // Trigger effects - fire action when component is ready
  useEffect(() => {
    if (shouldTriggerScan && activeView === 'security' && checkovRef.current) {
      checkovRef.current.triggerScan();
      setShouldTriggerScan(false);
    }
  }, [shouldTriggerScan, activeView]);

  useEffect(() => {
    if (shouldTriggerCost && activeView === 'cost') {
      if (workflowType === 'kubernetes' && k8sCostRef.current) {
        k8sCostRef.current.triggerAnalysis();
        setShouldTriggerCost(false);
      } else if (costRef.current) {
        costRef.current.triggerAnalysis();
        setShouldTriggerCost(false);
      }
    }
  }, [shouldTriggerCost, activeView, workflowType]);

  useEffect(() => {
    if (shouldTriggerRefactor && activeView === 'refactor') {
      if (workflowType === 'docker' && dockerBestPracticesRef.current) {
        dockerBestPracticesRef.current.triggerValidate();
        setShouldTriggerRefactor(false);
      } else if (refactorRef.current) {
        refactorRef.current.triggerValidate();
        setShouldTriggerRefactor(false);
      }
    }
  }, [shouldTriggerRefactor, activeView, workflowType]);

  useEffect(() => {
    if (shouldTriggerDiagram && activeView === 'diagram' && diagramRef.current) {
      diagramRef.current.triggerGenerate();
      setShouldTriggerDiagram(false);
    }
  }, [shouldTriggerDiagram, activeView]);

  useEffect(() => {
    if (shouldTriggerValidate && activeView === 'validate' && kubernetesValidatorRef.current) {
      kubernetesValidatorRef.current.triggerValidate();
      setShouldTriggerValidate(false);
    }
  }, [shouldTriggerValidate, activeView]);

  // Mark an activity as completed so future clicks just switch view
  const markCompleted = useCallback((activity: Activity) => {
    setCompletedActivities(prev => new Set(prev).add(activity));
  }, []);

  // Click handlers: first click triggers action, subsequent clicks just switch view
  const handleSecurityScan = () => {
    if (completedActivities.has('security')) {
      setActiveView('security'); // Just show existing results
      return;
    }
    setRunningActivity('security');
    setActiveView('security');
    setShouldTriggerScan(true);
  };

  const handleCostAnalysis = () => {
    if (completedActivities.has('cost')) {
      setActiveView('cost');
      return;
    }
    setRunningActivity('cost');
    setActiveView('cost');
    setShouldTriggerCost(true);
  };

  const handleRefactorValidate = () => {
    if (completedActivities.has('refactor')) {
      setActiveView('refactor');
      return;
    }
    setRunningActivity('refactor');
    setActiveView('refactor');
    setShouldTriggerRefactor(true);
  };

  const handleDiagramGenerate = () => {
    if (completedActivities.has('diagram')) {
      setActiveView('diagram');
      return;
    }
    setRunningActivity('diagram');
    setActiveView('diagram');
    setShouldTriggerDiagram(true);
  };

  const handleValidate = () => {
    if (completedActivities.has('validate')) {
      setActiveView('validate');
      return;
    }
    setRunningActivity('validate');
    setActiveView('validate');
    setShouldTriggerValidate(true);
  };

  const handleSyncValidate = () => {
    if (completedActivities.has('sync')) {
      setActiveView('sync');
      return;
    }
    setRunningActivity('sync');
    setActiveView('sync');
    setSyncRunSignal((prev) => prev + 1);
  };

  const handleActivityComplete = (activity: Activity) => {
    setRunningActivity(null);
    markCompleted(activity);

    if (pipelineActiveRef.current) {
      // Running via "Run Pipeline" — orchestrated mode
      const allStages = getPipelineStages();
      const stageIndex = allStages.indexOf(activity);
      onPipelineStageComplete?.(activity, stageIndex, allStages.length);
      if (pipelineQueueRef.current.length > 0) {
        if (pipelineLayout === 'sidebar') {
          const next = pipelineQueueRef.current[0];
          if (skipNextSidebarPauseRef.current) {
            skipNextSidebarPauseRef.current = false;
            pipelineQueueRef.current.shift();
            setPendingNextStage(null);
            setInternalPipelineRunning(true);
            setTimeout(() => triggerActivity(next), 300);
          } else {
            setPendingNextStage(next);
            setInternalPipelineRunning(false);
          }
        } else {
          const next = pipelineQueueRef.current.shift()!;
          setTimeout(() => triggerActivity(next), 300);
        }
      } else {
        pipelineActiveRef.current = false;
        setInternalPipelineRunning(false);
        const autoCompleteSidebar = workflowType === 'migrateops';
        if (pipelineLayout === 'sidebar' && !autoCompleteSidebar) {
          setBuildFinishPending(true);
          // Sidebar (non-MigrateOps): let user review final results before completing.
          // onPipelineComplete fires when user clicks "Complete Build".
        } else {
          onPipelineComplete?.();
        }
      }
    } else {
      // Manual mode: user clicked individual stage buttons.
      // Check if ALL pipeline stages are now complete — if so, auto-save build history.
      const allStages = getPipelineStages();
      // Use updated set: current completedActivities + this activity
      const updatedCompleted = new Set(completedActivities);
      updatedCompleted.add(activity);
      if (allStages.length > 0 && allStages.every(s => updatedCompleted.has(s))) {
        // All stages done — show "Complete Build" button
        setBuildFinishPending(true);
        if (pipelineLayout !== 'sidebar') {
          onPipelineComplete?.();
        }
        // For sidebar: deferred to "Complete Build" button click
      }
    }
  };

  // Called when user clicks "Continue to next stage" in sidebar
  const approveAndContinue = () => {
    if (!pendingNextStage) return;
    const next = pendingNextStage;
    pipelineQueueRef.current.shift(); // consume from queue
    setPendingNextStage(null);
    pipelineActiveRef.current = true;
    setInternalPipelineRunning(true);
    setTimeout(() => triggerActivity(next), 150);
  };

  const getPipelineStages = (): Activity[] => {
    if (workflowType === 'kubernetes') return ['diagram', 'validate', 'security'];
    if (workflowType === 'docker') return ['refactor', 'security'];
    if (workflowType === 'archme') return ['security', 'cost'];
    if (workflowType === 'migrateops') return ['diagram', 'sync'];
    // Terraform (all module approaches): architecture → best approach → security → cost
    if (workflowType === 'terraform') return ['diagram', 'refactor', 'security', 'cost'];
    return ['diagram', 'refactor', 'security', 'cost'];
  };

  const triggerActivity = (activity: Activity) => {
    setRunningActivity(activity);
    setActiveView(activity);
    if (activity === 'security') setShouldTriggerScan(true);
    else if (activity === 'cost') setShouldTriggerCost(true);
    else if (activity === 'refactor') setShouldTriggerRefactor(true);
    else if (activity === 'diagram') setShouldTriggerDiagram(true);
    else if (activity === 'validate') setShouldTriggerValidate(true);
    else if (activity === 'sync') setSyncRunSignal((prev) => prev + 1);
  };

  // Trigger pipeline programmatically (used by sidebar "Run Pipeline" button)
  const startPipelineInternal = useCallback(() => {
    if (pipelineActiveRef.current) return;
    pipelineStartedRef.current = true;
    const stages = getPipelineStages();
    pipelineQueueRef.current = [...stages.slice(1)];
    pipelineActiveRef.current = true;
    setInternalPipelineRunning(true);
    setPendingNextStage(null);
    setBuildFinishPending(false);
    setSecurityPendingCompletion(false);
    securityScanCountRef.current = 0;
    skipNextSidebarPauseRef.current = false;
    setCompletedActivities(new Set());
    triggerActivity(stages[0]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowType, moduleApproach]);

  // Auto-run pipeline when autoRun flips to true; reset guard when it flips back
  useEffect(() => {
    if (!autoRun) {
      pipelineStartedRef.current = false; // allow re-run next time
      return;
    }
    if (pipelineStartedRef.current) return;
    pipelineStartedRef.current = true;
    const stages = getPipelineStages();
    pipelineQueueRef.current = [...stages.slice(1)]; // queue remaining after first
    pipelineActiveRef.current = true;
    setInternalPipelineRunning(true);
    setPendingNextStage(null);
    setBuildFinishPending(false);
    securityScanCountRef.current = 0;
    skipNextSidebarPauseRef.current = false;
    setCompletedActivities(new Set()); // reset so stages re-run
    triggerActivity(stages[0]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRun]);

  const isAnyRunning = runningActivity !== null;
  const isSecurityRunning = runningActivity === 'security';
  const isCostRunning = runningActivity === 'cost';
  const isRefactorRunning = runningActivity === 'refactor';
  const isDiagramRunning = runningActivity === 'diagram';
  const isValidateRunning = runningActivity === 'validate';
  const isSyncRunning = runningActivity === 'sync';
  const getActivityButtonClassName = (_activity: Activity) => "flex-1";

  // Check if all prior pipeline stages are completed before allowing a stage
  const isStageLocked = (stage: Activity): boolean => {
    const stages = getPipelineStages();
    const idx = stages.indexOf(stage);
    if (idx <= 0) return false; // first stage is never locked
    return !stages.slice(0, idx).every(s => completedActivities.has(s));
  };

  // ── Shared content panes (hidden/visible via display:none to preserve state) ──
  const contentPanes = (
    <>
      {/* Security Scan — rendered for all workflow types */}
      <div style={{ display: activeView === 'security' ? undefined : 'none' }}>
        <CheckovScanner
          ref={checkovRef}
          sessionId={sessionId}
          showDiffView={true}
          framework={checkovFramework || (workflowType === 'kubernetes' ? 'kubernetes' : workflowType === 'docker' ? 'docker' : 'terraform')}
          moduleApproach={moduleApproach}
          onScanComplete={(result) => {
            setRunningActivity(null);
            onScanResult?.(result);
            onScanComplete?.(result);
            if (result != null) {
              securityScanCountRef.current += 1;
              const hasFailed = (result?.summary?.failed ?? 0) > 0;
              if (hasFailed && securityScanCountRef.current < 2) {
                // First scan found issues — pause pipeline until user fixes/approves
                setSecurityPendingCompletion(true);
                setInternalPipelineRunning(false);
                pipelineActiveRef.current = false;
              } else {
                // Clean scan OR 2nd scan reached — advance pipeline (auto-complete build)
                handleActivityComplete('security');
              }
            } else {
              // Null result (error / no files) — always advance to keep pipeline moving
              handleActivityComplete('security');
            }
          }}
          onScanStart={() => { setRunningActivity('security'); setActiveView('security'); }}
          onFixStart={() => setFixingActivity('security')}
          onFixComplete={() => setFixingActivity(null)}
          onFixesApproved={() => {
            // Fixes approved — re-scan will auto-run and call onScanComplete,
            // which advances the pipeline when the re-scan passes.
            // Just reset the pending state so the re-scan can run freely.
            setSecurityPendingCompletion(false);
            pipelineActiveRef.current = true;
            onFixesApproved?.();
          }}
        />
      </div>

      <div style={{ display: activeView === 'cost' ? undefined : 'none' }}>
        {workflowType === 'kubernetes' ? (
          <KubernetesCostEstimator ref={k8sCostRef} sessionId={sessionId} onComplete={() => handleActivityComplete('cost')} />
        ) : (
          <CostAnalyzer ref={costRef} sessionId={sessionId}
            onCostComplete={(result) => onCostResult?.(result)}
            onAnalysisComplete={() => handleActivityComplete('cost')}
            onAnalysisStart={() => { setRunningActivity('cost'); setActiveView('cost'); }}
            onTerraformFilesChanged={onTerraformFilesChanged}
          />
        )}
      </div>

      {(workflowType === 'terraform' || workflowType === 'migrateops') && (
        <div style={{ display: activeView === 'refactor' ? undefined : 'none' }}>
          <RefactorValidator ref={refactorRef} sessionId={sessionId}
            onValidationComplete={() => {
              // Validation API returned — stop the spinner. Advancement is handled by onValidationResult.
              setRunningActivity(null);
            }}
            onValidationResult={(hasIssues) => {
              if (!hasIssues) {
                // Clean validation — advance pipeline immediately
                handleActivityComplete('refactor');
              } else {
                // Issues found — pause pipeline, let user fix + approve before advancing
                // Do NOT call handleActivityComplete here. The pipeline waits.
                if (pipelineActiveRef.current) {
                  pipelineActiveRef.current = false;
                  setInternalPipelineRunning(false);
                }
              }
            }}
            onValidationStart={() => { setRunningActivity('refactor'); setActiveView('refactor'); }}
            onFixStart={() => { setIsFixing(true); setFixingActivity('refactor'); }}
            onFixComplete={() => { setIsFixing(false); setFixingActivity(null); }}
            onFixesApproved={() => {
              // Files were approved — refresh the code editor
              onFixesApproved?.();
            }}
            onFixCycleComplete={() => {
              // User approved fixes + re-validation done — now advance the pipeline
              pipelineActiveRef.current = true;
              setInternalPipelineRunning(true);
              handleActivityComplete('refactor');
            }}
          />
        </div>
      )}

      {workflowType === 'docker' && (
        <div style={{ display: activeView === 'refactor' ? undefined : 'none' }}>
          <DockerBestPractices ref={dockerBestPracticesRef} sessionId={sessionId}
            onValidationComplete={() => handleActivityComplete('refactor')}
            onValidationStart={() => { setRunningActivity('refactor'); setActiveView('refactor'); }}
          />
        </div>
      )}

      {workflowType === 'kubernetes' && (
        <div style={{ display: activeView === 'validate' ? undefined : 'none' }}>
          <KubernetesValidator ref={kubernetesValidatorRef} sessionId={sessionId}
            onValidationComplete={() => {
              // Validation API returned — stop spinner. Advancement handled by onValidationResult.
              setRunningActivity(null);
            }}
            onValidationResult={(hasIssues) => {
              if (!hasIssues) {
                // Clean validation — advance pipeline immediately
                handleActivityComplete('validate');
              } else {
                // Issues found — pause pipeline, let user fix + approve before advancing
                if (pipelineActiveRef.current) {
                  pipelineActiveRef.current = false;
                  setInternalPipelineRunning(false);
                }
              }
            }}
            onValidationStart={() => { setRunningActivity('validate'); setActiveView('validate'); }}
            onFixStart={() => { setIsFixing(true); setFixingActivity('validate'); }}
            onFixComplete={() => { setIsFixing(false); setFixingActivity(null); }}
            onFixesApproved={() => {
              onFixesApproved?.();
            }}
            onFixCycleComplete={() => {
              // User approved fixes + re-validation done — resume pipeline
              pipelineActiveRef.current = true;
              setInternalPipelineRunning(true);
              if (workflowType === 'kubernetes' && pipelineLayout === 'sidebar') {
                skipNextSidebarPauseRef.current = true;
              }
              handleActivityComplete('validate');
            }}
          />
        </div>
      )}

      {workflowType !== 'docker' && workflowType !== 'archme' && (
        <div style={{ display: activeView === 'diagram' ? undefined : 'none' }}>
          <ArchitectureDiagram ref={diagramRef} sessionId={sessionId} useArchMeEndpoint={false} workflowType={(workflowType === 'migrateops' ? 'terraform' : workflowType) as 'terraform' | 'kubernetes'}
            onDiagramComplete={(result) => { if (result) onDiagramResult?.(result); handleActivityComplete('diagram'); }}
            onDiagramStart={() => { setRunningActivity('diagram'); setActiveView('diagram'); }}
          />
        </div>
      )}

      {workflowType === 'migrateops' && (
        <div style={{ display: activeView === 'sync' ? undefined : 'none' }}>
          <MigrateSyncValidator
            sessionId={sessionId}
            autoRunSignal={syncRunSignal}
            onRunStateChange={(state, result) => {
              if (state === 'running') {
                setRunningActivity('sync');
                setActiveView('sync');
                return;
              }
              if (state === 'error') {
                setRunningActivity(null);
                if (pipelineActiveRef.current) {
                  pipelineActiveRef.current = false;
                  setInternalPipelineRunning(false);
                }
                return;
              }
              if (state === 'done') {
                if (result?.summary?.status === 'in_sync') {
                  handleActivityComplete('sync');
                  return;
                }
                // Drift found: keep stage open for review and block pipeline completion.
                setRunningActivity(null);
                if (pipelineActiveRef.current) {
                  pipelineActiveRef.current = false;
                  setInternalPipelineRunning(false);
                }
              }
            }}
            onComplete={(result) => {
              // keep callback for compatibility; stage advancement handled by onRunStateChange
            }}
          />
        </div>
      )}
    </>
  );

  // ── Sidebar layout (dark left panel + content right) ──
  if (pipelineLayout === 'sidebar') {
    const stages = getPipelineStages();
    return (
      <div className="rounded-2xl overflow-hidden border border-zinc-200 dark:border-zinc-800 flex min-h-[520px]" role="region" aria-label="Build pipeline">
        {/* Left Sidebar */}
        <div className="w-52 flex-shrink-0 bg-zinc-950 border-r border-zinc-800 flex flex-col">
          {/* Header */}
          <div className="px-4 py-3.5 border-b border-zinc-800 flex items-center gap-2">
            {internalPipelineRunning && <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />}
            <p className="text-xs font-bold uppercase tracking-widest text-zinc-300">Pipeline</p>
          </div>

          {/* Stage list */}
          <nav className="flex-1 py-1.5">
            {stages.map((stage, idx) => {
              const isCompleted = completedActivities.has(stage);
              const isRunning = runningActivity === stage;
              const isActive = activeView === stage;
              const info = STAGE_INFO[stage] ?? { label: stage, icon: Activity };
              // A stage is locked if any prior stage hasn't completed yet
              const isLocked = idx > 0 && !stages.slice(0, idx).every(s => completedActivities.has(s));
              return (
                <button
                  key={stage}
                  onClick={() => { if (!isLocked) setActiveView(stage); }}
                  disabled={isLocked}
                  className={`w-full flex items-center gap-2.5 px-4 py-2.5 text-left transition-colors ${
                    isLocked
                      ? 'opacity-40 cursor-not-allowed'
                      : isActive
                        ? 'bg-zinc-800 text-white'
                        : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
                  }`}
                  title={isLocked ? `Complete ${STAGE_INFO[stages[idx - 1]]?.label ?? stages[idx - 1]} first` : undefined}
                >
                  <span className="flex-shrink-0 w-4 h-4 flex items-center justify-center">
                    {isRunning
                      ? <Loader2 className="w-4 h-4 animate-spin text-blue-400" />
                      : (securityPendingCompletion && stage === 'security')
                        ? <span className="w-3.5 h-3.5 rounded-full border-2 border-amber-500 bg-amber-500/20 block" title="Issues found — fix before completing" />
                        : isCompleted
                          ? <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                          : isLocked
                            ? <span className="w-3.5 h-3.5 rounded-full border-2 border-zinc-700 block" />
                            : <span className="w-3.5 h-3.5 rounded-full border-2 border-zinc-600 block" />}
                  </span>
                  <span className="text-sm leading-tight">
                    <span className="text-zinc-600 mr-1">{idx + 1}.</span>
                    <span className={
                      isRunning ? 'text-blue-300'
                      : (securityPendingCompletion && stage === 'security') ? 'text-amber-400'
                      : isCompleted ? 'text-zinc-100'
                      : isLocked ? 'text-zinc-600'
                      : ''
                    }>{info.label}</span>
                  </span>
                </button>
              );
            })}
          </nav>

          {/* Sidebar footer: pipeline status / run button */}
          <div className="p-3 border-t border-zinc-800">
            {internalPipelineRunning ? (
              <div className="flex items-center gap-2 text-xs text-zinc-400 py-1.5 px-1">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-400 flex-shrink-0" />
                <span>Running…</span>
              </div>
            ) : securityPendingCompletion ? (
              <Button
                size="sm"
                data-testid="btn-complete-build"
                className="w-full gap-1.5 text-xs"
                onClick={() => {
                  // Security is the last pipeline stage — mark done and show
                  // the "Complete Build" footer so user can review final state.
                  setSecurityPendingCompletion(false);
                  pipelineActiveRef.current = false;
                  setInternalPipelineRunning(false);
                  setBuildFinishPending(true);
                  markCompleted('security');
                  setRunningActivity(null);
                }}
              >
                Complete Build <ChevronRight className="w-3.5 h-3.5" />
              </Button>
            ) : pendingNextStage ? (
              <div className="text-xs text-zinc-500 py-1.5 px-1 text-center">Review results →</div>
            ) : buildFinishPending ? (
              <div className="flex items-center gap-1.5 text-xs text-emerald-400 py-1.5 px-1">
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>All stages done</span>
              </div>
            ) : completedActivities.size === stages.length && stages.length > 0 ? (
              <Button size="sm" variant="outline" className="w-full gap-1.5 text-xs border-zinc-700 text-zinc-300 hover:bg-zinc-800 hover:text-white"
                onClick={() => { startPipelineInternal(); onRequestRunPipeline?.(); }}>
                <PlayCircle className="w-3.5 h-3.5" /> Re-run Pipeline
              </Button>
            ) : (
              <Button size="sm" className="w-full gap-1.5 text-xs bg-primary hover:bg-primary/90"
                onClick={() => { startPipelineInternal(); onRequestRunPipeline?.(); }}>
                <PlayCircle className="w-3.5 h-3.5" /> Run Pipeline
              </Button>
            )}
          </div>
        </div>

        {/* Right content area */}
        <div className="flex-1 bg-zinc-950 overflow-auto flex flex-col min-h-0">

          {/* Empty state — no stage selected yet */}
          {!activeView && !runningActivity && (
            <div className="flex-1 flex items-center justify-center min-h-64">
              <div className="text-center space-y-3">
                <Activity className="w-12 h-12 mx-auto text-zinc-700" />
                <p className="text-sm font-medium text-zinc-400">Click a stage or Run Pipeline to start</p>
                <p className="text-xs text-zinc-600">
                  {workflowType === 'migrateops'
                    ? 'Architecture → Sync'
                    : workflowType === 'terraform'
                      ? 'Architecture → Best Approach → Security → Cost'
                      : 'Architecture → Best Practices → Security'}
                </p>
              </div>
            </div>
          )}

          {/* Terminal console — shown while a stage is running OR a fix is in progress */}
          {(runningActivity || fixingActivity) && (
            <div className="flex-1 p-5 overflow-auto font-mono text-sm">
              <div className="mb-3 flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-red-500" />
                <span className="w-2.5 h-2.5 rounded-full bg-yellow-500" />
                <span className="w-2.5 h-2.5 rounded-full bg-green-500" />
                <span className="ml-2 text-xs text-zinc-500 uppercase tracking-widest">
                  {fixingActivity
                    ? `${STAGE_INFO[fixingActivity]?.label ?? fixingActivity} — Fixing`
                    : (STAGE_INFO[runningActivity!]?.label ?? runningActivity)}
                </span>
                {fixingActivity && (
                  <span className="ml-auto text-[10px] text-amber-400 uppercase tracking-widest animate-pulse">applying fixes</span>
                )}
              </div>
              <div className="space-y-1">
                {terminalLines.map((line, i) => (
                  <div
                    key={i}
                    className={`leading-relaxed ${
                      line.startsWith('$')
                        ? 'text-green-400 font-semibold'
                        : line.startsWith('  ✓')
                          ? 'text-emerald-400'
                          : line.startsWith('  ✗')
                            ? 'text-red-400'
                            : 'text-zinc-400'
                    }`}
                  >
                    {line}
                  </div>
                ))}
                <span className="inline-block w-2 h-4 bg-zinc-400 animate-pulse ml-0.5" />
              </div>
            </div>
          )}

          {/* Stage results — shown after stage completes AND no fix is running */}
          <div
            style={{ display: (!runningActivity && !fixingActivity && activeView) ? undefined : 'none' }}
            className="flex-1 bg-background overflow-auto p-5"
          >
            {contentPanes}
          </div>

          {/* Security issues banner — shown when scan found failures and awaiting user action */}
          {securityPendingCompletion && !fixingActivity && (
            <div className="flex-shrink-0 border-t border-amber-800 bg-amber-950/60 px-5 py-3 flex items-center gap-3">
              <Shield className="w-4 h-4 text-amber-400 flex-shrink-0" />
              <span className="text-sm text-amber-300">
                Security issues found — select checks above, apply fixes, then click <strong className="text-amber-200">Complete Build</strong> in the left panel.
              </span>
            </div>
          )}

          {/* Stage approval footer — shown after each stage completes */}
          {pendingNextStage && (
            <div className="flex-shrink-0 border-t border-zinc-800 bg-zinc-900 px-5 py-3 flex items-center justify-between gap-4">
              <span className="text-sm text-zinc-400 flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0" />
                Stage complete — review results then continue
              </span>
              <Button size="sm" className="gap-2 flex-shrink-0" onClick={approveAndContinue}>
                Next: {STAGE_INFO[pendingNextStage]?.label ?? pendingNextStage}
                <ChevronRight className="w-4 h-4" />
              </Button>
            </div>
          )}

          {/* Build complete footer — shown after all stages finish */}
          {buildFinishPending && (
            <div className="flex-shrink-0 border-t border-emerald-800 bg-emerald-950/60 px-5 py-3 flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                <span className="text-sm text-emerald-400">All pipeline stages complete</span>
              </div>
              <Button size="sm" className="gap-2 flex-shrink-0" onClick={() => {
                onPipelineComplete?.();
                onViewBuildSummary?.();
              }} data-testid="button-view-build-summary">
                Complete Build <ChevronRight className="w-4 h-4" />
              </Button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Default layout (horizontal button bar) ──
  return (
    <div className="w-full space-y-6" role="region" aria-label="Activity panel">
      {/* Horizontal Button Bar */}
      <div className="flex flex-wrap gap-3 mb-6" role="toolbar" aria-label="Activity actions">
        {/* Best Approach - shown when refactor stage is in the pipeline */}
        {getPipelineStages().includes('refactor') && !isFixing && (
          <Button
            onClick={handleRefactorValidate}
            disabled={isAnyRunning || isStageLocked('refactor')}
            variant={activeView === 'refactor' ? 'default' : 'outline'}
            className={getActivityButtonClassName('refactor')}
            data-testid="button-refactor-validate"
            title={isStageLocked('refactor') ? 'Complete prior stages first' : undefined}
          >
            {isRefactorRunning ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Validating...
              </>
            ) : (
              <>
                <Wrench className="w-4 h-4 mr-2" />
                Best Approach
              </>
            )}
          </Button>
        )}
        {/* Draw - not for Docker or ArchMe (ArchMe has diagram in step 1) */}
        {workflowType !== 'docker' && workflowType !== 'archme' && !isFixing && (
          <Button
            onClick={handleDiagramGenerate}
            disabled={isAnyRunning || isStageLocked('diagram')}
            variant={activeView === 'diagram' ? 'default' : 'outline'}
            className={getActivityButtonClassName('diagram')}
            data-testid="button-draw"
            title={isStageLocked('diagram') ? 'Complete prior stages first' : undefined}
          >
            {isDiagramRunning ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Drawing...
              </>
            ) : (
              <>
                <Network className="w-4 h-4 mr-2" />
                Draw
              </>
            )}
          </Button>
        )}

        {/* Cost Analysis - Terraform, Kubernetes, and ArchMe */}
        {(workflowType === 'terraform' || workflowType === 'kubernetes' || workflowType === 'archme') && !isFixing && (
          <Button
            onClick={handleCostAnalysis}
            disabled={isAnyRunning || isStageLocked('cost')}
            variant={activeView === 'cost' ? 'default' : 'outline'}
            className={getActivityButtonClassName('cost')}
            data-testid="button-cost-analysis"
            title={isStageLocked('cost') ? 'Complete prior stages first' : undefined}
          >
            {isCostRunning ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Analyzing...
              </>
            ) : (
              <>
                <DollarSign className="w-4 h-4 mr-2" />
                Cost Analysis
              </>
            )}
          </Button>
        )}

        {getPipelineStages().includes('sync') && !isFixing && (
          <Button
            onClick={handleSyncValidate}
            disabled={isAnyRunning || isStageLocked('sync')}
            variant={activeView === 'sync' ? 'default' : 'outline'}
            className={getActivityButtonClassName('sync')}
            data-testid="button-sync-validation"
            title={isStageLocked('sync') ? 'Complete prior stages first' : undefined}
          >
            {isSyncRunning ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Syncing...
              </>
            ) : (
              <>
                <RefreshCw className="w-4 h-4 mr-2" />
                Sync
              </>
            )}
          </Button>
        )}
        {/* Security Scan */}
        {!isFixing && getPipelineStages().includes('security') && (
          <Button
            onClick={handleSecurityScan}
            disabled={isAnyRunning || isStageLocked('security')}
            variant={activeView === 'security' ? 'default' : 'outline'}
            className={getActivityButtonClassName('security')}
            data-testid="button-security-scan"
            title={isStageLocked('security') ? 'Complete prior stages first' : undefined}
          >
            {isSecurityRunning ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Scanning...
              </>
            ) : (
              <>
                <Shield className="w-4 h-4 mr-2" />
                Security Scan
              </>
            )}
          </Button>
        )}

        {/* Best Approach - Kubernetes only */}
        {workflowType === 'kubernetes' && !isFixing && (
          <Button
            onClick={handleValidate}
            disabled={isAnyRunning || isStageLocked('validate')}
            variant={activeView === 'validate' ? 'default' : 'outline'}
            className={getActivityButtonClassName('validate')}
            data-testid="button-validate"
            title={isStageLocked('validate') ? 'Complete prior stages first' : undefined}
          >
            {isValidateRunning ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Analysing...
              </>
            ) : (
              <>
                <Wrench className="w-4 h-4 mr-2" />
                Best Approach
              </>
            )}
          </Button>
        )}
      </div>

      {/* All activity components stay mounted to preserve state (display:none for inactive views) */}
      {contentPanes}

      {!activeView && (
        <div className="border rounded-lg p-8 text-center text-muted-foreground">
          <p>Select an activity above to get started</p>
        </div>
      )}
    </div>
  );
}
