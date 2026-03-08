import { useState, useRef, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Shield, DollarSign, Wrench, Loader2, Network } from "lucide-react";
import CheckovScanner, { CheckovScannerRef } from "./CheckovScanner";
import CostAnalyzer, { CostAnalyzerRef } from "./CostAnalyzer";
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
}

type Activity = 'security' | 'cost' | 'refactor' | 'diagram' | 'validate';
type RunningActivity = Activity | null;

export default function ActivityPanel({ sessionId, onScanComplete, onFixesApproved, workflowType = 'terraform', moduleApproach = null, checkovFramework }: ActivityPanelProps) {
  const [runningActivity, setRunningActivity] = useState<RunningActivity>(null);
  const [activeView, setActiveView] = useState<RunningActivity>(null);
  // Track which activities have completed at least once - don't re-trigger on view switch
  const [completedActivities, setCompletedActivities] = useState<Set<Activity>>(new Set());
  const [shouldTriggerScan, setShouldTriggerScan] = useState(false);
  const [shouldTriggerCost, setShouldTriggerCost] = useState(false);
  const [shouldTriggerRefactor, setShouldTriggerRefactor] = useState(false);
  const [shouldTriggerDiagram, setShouldTriggerDiagram] = useState(false);
  const [shouldTriggerValidate, setShouldTriggerValidate] = useState(false);
  const [isFixing, setIsFixing] = useState(false);
  const checkovRef = useRef<CheckovScannerRef>(null);
  const costRef = useRef<CostAnalyzerRef>(null);
  const refactorRef = useRef<RefactorValidatorRef>(null);
  const diagramRef = useRef<ArchitectureDiagramRef>(null);
  const kubernetesValidatorRef = useRef<KubernetesValidatorRef>(null);
  const kubernetesBestPracticesRef = useRef<KubernetesBestPracticesRef>(null);
  const dockerBestPracticesRef = useRef<DockerBestPracticesRef>(null);

  // Trigger effects - fire action when component is ready
  useEffect(() => {
    if (shouldTriggerScan && activeView === 'security' && checkovRef.current) {
      checkovRef.current.triggerScan();
      setShouldTriggerScan(false);
    }
  }, [shouldTriggerScan, activeView]);

  useEffect(() => {
    if (shouldTriggerCost && activeView === 'cost' && costRef.current) {
      costRef.current.triggerAnalysis();
      setShouldTriggerCost(false);
    }
  }, [shouldTriggerCost, activeView]);

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
  };

  const isAnyRunning = runningActivity !== null;
  const isSecurityRunning = runningActivity === 'security';
  const isCostRunning = runningActivity === 'cost';
  const isRefactorRunning = runningActivity === 'refactor';
  const isDiagramRunning = runningActivity === 'diagram';
  const isValidateRunning = runningActivity === 'validate';
  const isKubernetesWorkflow = workflowType === 'kubernetes';

  const getActivityButtonClassName = (activity: Activity) => {
    if (!isKubernetesWorkflow) return "flex-1";
    const isActive = activeView === activity;
    return isActive
      ? "flex-1 bg-blue-700 hover:bg-blue-800 border-blue-700 text-white"
      : "flex-1 bg-blue-600 hover:bg-blue-700 border-blue-600 text-white";
  };

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

        {/* Cost Analysis - Terraform and ArchMe (only when generating Terraform code) */}
        {(workflowType === 'terraform' || (workflowType === 'archme' && checkovFramework !== 'kubernetes')) && !isFixing && (
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

      {/* All activity components stay mounted to preserve state across switches.
         Inactive views are hidden with display:none so they retain their results. */}

      {/* Security Scan */}
      {!(workflowType === 'terraform' && moduleApproach === 'aggregated-root') && (
        <div style={{ display: activeView === 'security' ? undefined : 'none' }}>
          <CheckovScanner
            ref={checkovRef}
            sessionId={sessionId}
            framework={checkovFramework || (workflowType === 'kubernetes' ? 'kubernetes' : workflowType === 'docker' ? 'docker' : 'terraform')}
            onScanComplete={(result) => {
              // Only mark completed when we got a real result — null means the scan failed
              // (e.g. no files found, network error). Keeping it "not completed" lets the
              // user click the Security Scan button again to retry.
              if (result != null) {
                handleActivityComplete('security');
              } else {
                setRunningActivity(null); // clear spinner, but allow retry
              }
              onScanComplete?.(result);
            }}
            onScanStart={() => {
              setRunningActivity('security');
              setActiveView('security');
            }}
            onFixesApproved={() => {
              onFixesApproved?.();
            }}
          />
        </div>
      )}

      <div style={{ display: activeView === 'cost' ? undefined : 'none' }}>
        <CostAnalyzer
          ref={costRef}
          sessionId={sessionId}
          onAnalysisComplete={() => {
            handleActivityComplete('cost');
          }}
          onAnalysisStart={() => {
            setRunningActivity('cost');
            setActiveView('cost');
          }}
        />
      </div>

      {/* RefactorValidator (Terraform only) */}
      {workflowType === 'terraform' && (
        <div style={{ display: activeView === 'refactor' ? undefined : 'none' }}>
          <RefactorValidator
            ref={refactorRef}
            sessionId={sessionId}
            onValidationComplete={() => {
              handleActivityComplete('refactor');
            }}
            onValidationStart={() => {
              setRunningActivity('refactor');
              setActiveView('refactor');
            }}
            onFixStart={() => {
              setIsFixing(true);
              setRunningActivity(null);
            }}
            onFixComplete={() => {
              setIsFixing(false);
              setRunningActivity(null);
            }}
          />
        </div>
      )}

      {/* DockerBestPractices (Docker only) */}
      {workflowType === 'docker' && (
        <div style={{ display: activeView === 'refactor' ? undefined : 'none' }}>
          <DockerBestPractices
            ref={dockerBestPracticesRef}
            sessionId={sessionId}
            onValidationComplete={() => {
              handleActivityComplete('refactor');
            }}
            onValidationStart={() => {
              setRunningActivity('refactor');
              setActiveView('refactor');
            }}
          />
        </div>
      )}

      {/* KubernetesValidator (Kubernetes only) */}
      {workflowType === 'kubernetes' && (
        <div style={{ display: activeView === 'validate' ? undefined : 'none' }}>
          <KubernetesValidator
            ref={kubernetesValidatorRef}
            sessionId={sessionId}
            onValidationComplete={() => {
              handleActivityComplete('validate');
            }}
            onValidationStart={() => {
              setRunningActivity('validate');
              setActiveView('validate');
            }}
          />
        </div>
      )}

      {/* ArchitectureDiagram - not for Docker or ArchMe */}
      {workflowType !== 'docker' && workflowType !== 'archme' && (
        <div style={{ display: activeView === 'diagram' ? undefined : 'none' }}>
          <ArchitectureDiagram
            ref={diagramRef}
            sessionId={sessionId}
            useArchMeEndpoint={false}
            workflowType={workflowType}
            onDiagramComplete={() => {
              handleActivityComplete('diagram');
            }}
            onDiagramStart={() => {
              setRunningActivity('diagram');
              setActiveView('diagram');
            }}
          />
        </div>
      )}

      {!activeView && (
        <div className="border rounded-lg p-8 text-center text-muted-foreground">
          <p>Select an activity above to get started</p>
        </div>
      )}
    </div>
  );
}
