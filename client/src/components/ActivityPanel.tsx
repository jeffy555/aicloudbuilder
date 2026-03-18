import { useState, useRef, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Shield, DollarSign, Wrench, Loader2, Network, PlayCircle, CheckCircle2, Activity, ChevronRight } from "lucide-react";
import CheckovScanner, { CheckovScannerRef } from "./CheckovScanner";
import CostAnalyzer, { CostAnalyzerRef } from "./CostAnalyzer";
import KubernetesCostEstimator, { KubernetesCostEstimatorRef } from "./KubernetesCostEstimator";
import RefactorValidator, { RefactorValidatorRef } from "./RefactorValidator";
import ArchitectureDiagram, { ArchitectureDiagramRef } from "./ArchitectureDiagram";
import KubernetesValidator, { KubernetesValidatorRef } from "./KubernetesValidator";
import KubernetesBestPractices, { KubernetesBestPracticesRef } from "./KubernetesBestPractices";
import DockerBestPractices, { DockerBestPracticesRef } from "./DockerBestPractices";

interface ActivityPanelProps {
  sessionId: string;
  onScanComplete?: (result?: any) => void;
  onFixesApproved?: () => void;
  workflowType?: 'terraform' | 'kubernetes' | 'docker' | 'archme';
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
}

const STAGE_INFO: Record<string, { label: string; icon: React.ComponentType<any> }> = {
  security: { label: 'Security Scan',    icon: Shield },
  validate: { label: 'Best Practices',   icon: Wrench },
  cost:     { label: 'Cost Analysis',    icon: DollarSign },
  diagram:  { label: 'Architecture',     icon: Network },
  refactor: { label: 'Best Approach',    icon: Wrench },
};

type Activity = 'security' | 'cost' | 'refactor' | 'diagram' | 'validate';
type RunningActivity = Activity | null;

export default function ActivityPanel({ sessionId, onScanComplete, onFixesApproved, workflowType = 'terraform', moduleApproach = null, checkovFramework, autoRun = false, onPipelineStageComplete, onPipelineComplete, pipelineLayout = 'default', onRequestRunPipeline, onDiagramResult, onScanResult }: ActivityPanelProps) {
  const [runningActivity, setRunningActivity] = useState<RunningActivity>(null);
  const [activeView, setActiveView] = useState<RunningActivity>(null);
  // Track which activities have completed at least once - don't re-trigger on view switch
  const [completedActivities, setCompletedActivities] = useState<Set<Activity>>(new Set());
  const [shouldTriggerScan, setShouldTriggerScan] = useState(false);
  // Pipeline state
  const pipelineQueueRef = useRef<Activity[]>([]);
  const pipelineActiveRef = useRef(false);
  const pipelineStartedRef = useRef(false);
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
  const [isFixing, setIsFixing] = useState(false);
  const checkovRef = useRef<CheckovScannerRef>(null);
  const costRef = useRef<CostAnalyzerRef>(null);
  const k8sCostRef = useRef<KubernetesCostEstimatorRef>(null);
  const refactorRef = useRef<RefactorValidatorRef>(null);
  const diagramRef = useRef<ArchitectureDiagramRef>(null);
  const kubernetesValidatorRef = useRef<KubernetesValidatorRef>(null);
  const kubernetesBestPracticesRef = useRef<KubernetesBestPracticesRef>(null);
  const dockerBestPracticesRef = useRef<DockerBestPracticesRef>(null);

  // ── Terminal log lines per stage ─────────────────────────────────────────
  const STAGE_LOGS: Record<string, string[]> = {
    diagram: [
      '$ Generating architecture diagram...',
      '  → Parsing Kubernetes manifests',
      '  → Detecting resource kinds',
      '  → Mapping service relationships',
      '  → Resolving ingress routes',
      '  → Building node graph',
      '  → Laying out diagram',
      '  → Rendering architecture...',
    ],
    validate: [
      '$ Analysing Kubernetes manifests...',
      '  → Loading YAML files',
      '  → Running schema validation',
      '  → Checking apiVersion compatibility',
      '  → Evaluating resource configurations',
      '  → Analysing best practices',
      '  → Checking security context',
      '  → Evaluating probe configurations',
    ],
    security: [
      '$ Initialising security scanner...',
      '  → Loading Kubernetes resources',
      '  → Checking privilege escalation rules',
      '  → Scanning container security contexts',
      '  → Validating RBAC policies',
      '  → Checking host namespace isolation',
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
      '  → Reading CPU/memory requests',
      '  → Fetching cloud pricing data',
      '  → Calculating container costs',
    ],
  };

  // Drive terminal log lines while a stage is running
  useEffect(() => {
    // Clear any pending timers
    terminalTimersRef.current.forEach(t => clearTimeout(t));
    terminalTimersRef.current = [];

    if (!runningActivity || pipelineLayout !== 'sidebar') return;

    const lines = STAGE_LOGS[runningActivity] ?? [`$ Running ${runningActivity}...`];
    setTerminalLines([]);

    lines.forEach((line, i) => {
      const t = setTimeout(() => {
        setTerminalLines(prev => [...prev, line]);
      }, i * 600);
      terminalTimersRef.current.push(t);
    });

    return () => {
      terminalTimersRef.current.forEach(t => clearTimeout(t));
      terminalTimersRef.current = [];
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningActivity, pipelineLayout]);

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

  const handleActivityComplete = (activity: Activity) => {
    setRunningActivity(null);
    markCompleted(activity);
    if (pipelineActiveRef.current) {
      const allStages = getPipelineStages();
      const stageIndex = allStages.indexOf(activity);
      onPipelineStageComplete?.(activity, stageIndex, allStages.length);
      if (pipelineQueueRef.current.length > 0) {
        if (pipelineLayout === 'sidebar') {
          // Pause: show Continue button; user must approve before next stage
          setPendingNextStage(pipelineQueueRef.current[0]);
          setInternalPipelineRunning(false);
        } else {
          const next = pipelineQueueRef.current.shift()!;
          setTimeout(() => triggerActivity(next), 300);
        }
      } else {
        pipelineActiveRef.current = false;
        setInternalPipelineRunning(false);
        if (pipelineLayout === 'sidebar') {
          // Pause: show Finish Build button; user must approve to complete
          setBuildFinishPending(true);
        } else {
          onPipelineComplete?.();
        }
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

  // Called when user clicks "Finish Build" after last stage
  const finishBuild = () => {
    setBuildFinishPending(false);
    onPipelineComplete?.();
  };

  const getPipelineStages = (): Activity[] => {
    if (workflowType === 'kubernetes') return ['diagram', 'validate', 'security'];
    if (workflowType === 'docker') return ['refactor', 'security'];
    if (moduleApproach === 'aggregated-root') return ['cost', 'diagram'];
    return ['refactor', 'diagram', 'cost', 'security'];
  };

  const triggerActivity = (activity: Activity) => {
    setRunningActivity(activity);
    setActiveView(activity);
    if (activity === 'security') setShouldTriggerScan(true);
    else if (activity === 'cost') setShouldTriggerCost(true);
    else if (activity === 'refactor') setShouldTriggerRefactor(true);
    else if (activity === 'diagram') setShouldTriggerDiagram(true);
    else if (activity === 'validate') setShouldTriggerValidate(true);
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
  const getActivityButtonClassName = (_activity: Activity) => "flex-1";

  // ── Shared content panes (hidden/visible via display:none to preserve state) ──
  const contentPanes = (
    <>
      {/* Security Scan */}
      {!(workflowType === 'terraform' && moduleApproach === 'aggregated-root') && (
        <div style={{ display: activeView === 'security' ? undefined : 'none' }}>
          <CheckovScanner
            ref={checkovRef}
            sessionId={sessionId}
            framework={checkovFramework || (workflowType === 'kubernetes' ? 'kubernetes' : workflowType === 'docker' ? 'docker' : 'terraform')}
            onScanComplete={(result) => {
              if (result != null) {
                onScanResult?.(result);
                handleActivityComplete('security');
              } else if (pipelineActiveRef.current) {
                handleActivityComplete('security');
              } else {
                setRunningActivity(null);
              }
              onScanComplete?.(result);
            }}
            onScanStart={() => { setRunningActivity('security'); setActiveView('security'); }}
            onFixesApproved={() => { onFixesApproved?.(); }}
          />
        </div>
      )}

      <div style={{ display: activeView === 'cost' ? undefined : 'none' }}>
        {workflowType === 'kubernetes' ? (
          <KubernetesCostEstimator ref={k8sCostRef} sessionId={sessionId} onComplete={() => handleActivityComplete('cost')} />
        ) : (
          <CostAnalyzer ref={costRef} sessionId={sessionId}
            onAnalysisComplete={() => handleActivityComplete('cost')}
            onAnalysisStart={() => { setRunningActivity('cost'); setActiveView('cost'); }}
          />
        )}
      </div>

      {workflowType === 'terraform' && (
        <div style={{ display: activeView === 'refactor' ? undefined : 'none' }}>
          <RefactorValidator ref={refactorRef} sessionId={sessionId}
            onValidationComplete={() => handleActivityComplete('refactor')}
            onValidationStart={() => { setRunningActivity('refactor'); setActiveView('refactor'); }}
            onFixStart={() => { setIsFixing(true); setRunningActivity(null); }}
            onFixComplete={() => { setIsFixing(false); setRunningActivity(null); }}
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
            onValidationComplete={() => handleActivityComplete('validate')}
            onValidationStart={() => { setRunningActivity('validate'); setActiveView('validate'); }}
          />
        </div>
      )}

      {workflowType !== 'docker' && workflowType !== 'archme' && (
        <div style={{ display: activeView === 'diagram' ? undefined : 'none' }}>
          <ArchitectureDiagram ref={diagramRef} sessionId={sessionId} useArchMeEndpoint={false} workflowType={workflowType}
            onDiagramComplete={(result) => { if (result) onDiagramResult?.(result); handleActivityComplete('diagram'); }}
            onDiagramStart={() => { setRunningActivity('diagram'); setActiveView('diagram'); }}
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
              return (
                <button
                  key={stage}
                  onClick={() => setActiveView(stage)}
                  className={`w-full flex items-center gap-2.5 px-4 py-2.5 text-left transition-colors ${
                    isActive
                      ? 'bg-zinc-800 text-white'
                      : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
                  }`}
                >
                  <span className="flex-shrink-0 w-4 h-4 flex items-center justify-center">
                    {isRunning
                      ? <Loader2 className="w-4 h-4 animate-spin text-blue-400" />
                      : isCompleted
                        ? <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                        : <span className="w-3.5 h-3.5 rounded-full border-2 border-zinc-600 block" />}
                  </span>
                  <span className="text-sm leading-tight">
                    <span className="text-zinc-600 mr-1">{idx + 1}.</span>
                    <span className={isRunning ? 'text-blue-300' : isCompleted ? 'text-zinc-100' : ''}>{info.label}</span>
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
                <p className="text-xs text-zinc-600">Architecture → Best Practices → Security</p>
              </div>
            </div>
          )}

          {/* Terminal console — shown while a stage is actively running */}
          {runningActivity && (
            <div className="flex-1 p-5 overflow-auto font-mono text-sm">
              <div className="mb-3 flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-red-500" />
                <span className="w-2.5 h-2.5 rounded-full bg-yellow-500" />
                <span className="w-2.5 h-2.5 rounded-full bg-green-500" />
                <span className="ml-2 text-xs text-zinc-500 uppercase tracking-widest">
                  {STAGE_INFO[runningActivity]?.label ?? runningActivity}
                </span>
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

          {/* Stage results — shown after stage completes; always mounted so refs work */}
          <div
            style={{ display: (!runningActivity && activeView) ? undefined : 'none' }}
            className="flex-1 bg-background overflow-auto p-5"
          >
            {contentPanes}
          </div>

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

          {/* Finish Build footer — shown after last stage completes */}
          {buildFinishPending && (
            <div className="flex-shrink-0 border-t border-emerald-800 bg-emerald-950/60 px-5 py-3 flex items-center justify-between gap-4">
              <span className="text-sm text-emerald-400 flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
                All pipeline stages complete — review then finish
              </span>
              <Button size="sm" className="gap-2 flex-shrink-0 bg-emerald-600 hover:bg-emerald-700 text-white" onClick={finishBuild}>
                <CheckCircle2 className="w-4 h-4" /> Finish Build
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
        {/* Best Approach - Terraform (not aggregated-root) and Docker */}
        {((workflowType === 'terraform' && moduleApproach !== 'aggregated-root') || workflowType === 'docker') && !isFixing && (
          <Button
            onClick={handleRefactorValidate}
            disabled={isAnyRunning}
            variant={activeView === 'refactor' ? 'default' : 'outline'}
            className={getActivityButtonClassName('refactor')}
            data-testid="button-refactor-validate"
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
            disabled={isAnyRunning}
            variant={activeView === 'diagram' ? 'default' : 'outline'}
            className={getActivityButtonClassName('diagram')}
            data-testid="button-draw"
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
        {(workflowType === 'terraform' || workflowType === 'kubernetes' || (workflowType === 'archme' && checkovFramework !== 'kubernetes')) && !isFixing && (
          <Button
            onClick={handleCostAnalysis}
            disabled={isAnyRunning}
            variant={activeView === 'cost' ? 'default' : 'outline'}
            className={getActivityButtonClassName('cost')}
            data-testid="button-cost-analysis"
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
        {/* Security Scan - not for aggregated-root */}
        {!isFixing && !(workflowType === 'terraform' && moduleApproach === 'aggregated-root') && (
          <Button
            onClick={handleSecurityScan}
            disabled={isAnyRunning}
            variant={activeView === 'security' ? 'default' : 'outline'}
            className={getActivityButtonClassName('security')}
            data-testid="button-security-scan"
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
            disabled={isAnyRunning}
            variant={activeView === 'validate' ? 'default' : 'outline'}
            className={getActivityButtonClassName('validate')}
            data-testid="button-validate"
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
