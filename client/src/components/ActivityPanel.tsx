import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Shield, DollarSign, Wrench, Loader2, Network } from "lucide-react";
import CheckovScanner, { CheckovScannerRef } from "./CheckovScanner";
import CostAnalyzer, { CostAnalyzerRef } from "./CostAnalyzer";
import RefactorValidator, { RefactorValidatorRef } from "./RefactorValidator";
import ArchitectureDiagram, { ArchitectureDiagramRef } from "./ArchitectureDiagram";
import KubernetesValidator, { KubernetesValidatorRef } from "./KubernetesValidator";
import KubernetesBestPractices, { KubernetesBestPracticesRef } from "./KubernetesBestPractices";

interface ActivityPanelProps {
  sessionId: string;
  onScanComplete?: (result?: any) => void; // Allow passing scan result
  workflowType?: 'terraform' | 'kubernetes' | 'docker'; // Add workflow type prop
  moduleApproach?: 'child-module' | 'standalone-root' | 'aggregated-root' | null; // Module approach for Terraform
}

type RunningActivity = 'security' | 'cost' | 'refactor' | 'diagram' | 'validate' | null;

export default function ActivityPanel({ sessionId, onScanComplete, workflowType = 'terraform', moduleApproach = null }: ActivityPanelProps) {
  const [runningActivity, setRunningActivity] = useState<RunningActivity>(null);
  const [activeView, setActiveView] = useState<RunningActivity>(null); // Track which view to show
  const [shouldTriggerScan, setShouldTriggerScan] = useState(false);
  const [shouldTriggerCost, setShouldTriggerCost] = useState(false);
  const [shouldTriggerRefactor, setShouldTriggerRefactor] = useState(false);
  const [shouldTriggerDiagram, setShouldTriggerDiagram] = useState(false);
  const [shouldTriggerValidate, setShouldTriggerValidate] = useState(false);
  const [isFixing, setIsFixing] = useState(false); // Track if fix is in progress
  const checkovRef = useRef<CheckovScannerRef>(null);
  const costRef = useRef<CostAnalyzerRef>(null);
  const refactorRef = useRef<RefactorValidatorRef>(null);
  const diagramRef = useRef<ArchitectureDiagramRef>(null);
  const kubernetesValidatorRef = useRef<KubernetesValidatorRef>(null);
  const kubernetesBestPracticesRef = useRef<KubernetesBestPracticesRef>(null);

  // Trigger scan after CheckovScanner component is mounted
  useEffect(() => {
    if (shouldTriggerScan && activeView === 'security' && checkovRef.current) {
      checkovRef.current.triggerScan();
      setShouldTriggerScan(false);
    }
  }, [shouldTriggerScan, activeView]);

  // Trigger cost analysis after CostAnalyzer component is mounted
  useEffect(() => {
    if (shouldTriggerCost && activeView === 'cost' && costRef.current) {
      costRef.current.triggerAnalysis();
      setShouldTriggerCost(false);
    }
  }, [shouldTriggerCost, activeView]);

  // Trigger validation after RefactorValidator component is mounted
  useEffect(() => {
    if (shouldTriggerRefactor && activeView === 'refactor' && refactorRef.current) {
      refactorRef.current.triggerValidate();
      setShouldTriggerRefactor(false);
    }
  }, [shouldTriggerRefactor, activeView]);

  // Trigger diagram generation after ArchitectureDiagram component is mounted
  useEffect(() => {
    if (shouldTriggerDiagram && activeView === 'diagram' && diagramRef.current) {
      diagramRef.current.triggerGenerate();
      setShouldTriggerDiagram(false);
    }
  }, [shouldTriggerDiagram, activeView]);

  // Trigger Kubernetes validation after component is mounted
  useEffect(() => {
    if (shouldTriggerValidate && activeView === 'validate' && kubernetesValidatorRef.current) {
      kubernetesValidatorRef.current.triggerValidate();
      setShouldTriggerValidate(false);
    }
  }, [shouldTriggerValidate, activeView]);

  const handleSecurityScan = () => {
    setRunningActivity('security');
    setActiveView('security'); // Show security view
    setShouldTriggerScan(true); // Trigger scan after component mounts
  };

  const handleCostAnalysis = () => {
    setRunningActivity('cost');
    setActiveView('cost'); // Show cost view
    setShouldTriggerCost(true); // Trigger analysis after component mounts
  };

  const handleRefactorValidate = () => {
    setRunningActivity('refactor');
    setActiveView('refactor'); // Show refactor view
    setShouldTriggerRefactor(true); // Trigger validation after component mounts
  };

  const handleDiagramGenerate = () => {
    setRunningActivity('diagram');
    setActiveView('diagram'); // Show diagram view
    setShouldTriggerDiagram(true); // Trigger generation after component mounts
  };

  const handleValidate = () => {
    setRunningActivity('validate');
    setActiveView('validate'); // Show validate view
    setShouldTriggerValidate(true); // Trigger validation after component mounts
  };

  const handleActivityComplete = () => {
    setRunningActivity(null);
    // Keep activeView so results stay visible
  };

  const isAnyRunning = runningActivity !== null;
  const isSecurityRunning = runningActivity === 'security';
  const isCostRunning = runningActivity === 'cost';
  const isRefactorRunning = runningActivity === 'refactor';
  const isDiagramRunning = runningActivity === 'diagram';
  const isValidateRunning = runningActivity === 'validate';

  return (
    <div className="w-full space-y-6" role="region" aria-label="Activity panel">
      {/* Horizontal Button Bar - Order: Best Approach → Draw → Cost Analysis → Scanning */}
      {/* For Kubernetes: Draw → Security Scan → Validate (Best Approach removed) */}
      <div className="flex flex-wrap gap-3 mb-6" role="toolbar" aria-label="Activity actions">
        {/* Best Approach - Only for Terraform, but NOT for aggregated-root */}
        {workflowType === 'terraform' && moduleApproach !== 'aggregated-root' && !isFixing && (!isAnyRunning || isRefactorRunning) ? (
          <Button
            onClick={handleRefactorValidate}
            disabled={isRefactorRunning}
            variant="default"
            className="flex-1"
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
        ) : null}
        {/* Draw - First for Kubernetes, Second for Terraform (not for Docker) */}
        {workflowType !== 'docker' && !isFixing && (!isAnyRunning || isDiagramRunning) ? (
          <Button
            onClick={handleDiagramGenerate}
            disabled={isDiagramRunning || (workflowType === 'terraform' && isRefactorRunning)}
            variant="default"
            className="flex-1"
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
        ) : null}
        
        {/* Cost Analysis - Only for Terraform */}
        {workflowType === 'terraform' && !isFixing && (!isAnyRunning || isCostRunning) ? (
          <Button
            onClick={handleCostAnalysis}
            disabled={isCostRunning || isRefactorRunning}
            variant="default"
            className="flex-1"
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
        ) : null}
        {/* Security Scan - Second for Kubernetes, Third for Terraform */}
        {/* Hidden for aggregated-root Terraform modules (child module scanned separately) */}
        {!isFixing && (!isAnyRunning || isSecurityRunning) && !(workflowType === 'terraform' && moduleApproach === 'aggregated-root') ? (
          <Button
            onClick={handleSecurityScan}
            disabled={isSecurityRunning || (workflowType === 'terraform' && isRefactorRunning)}
            variant="default"
            className="flex-1"
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
        ) : null}
        
        {/* Validate - Only for Kubernetes (Fourth) */}
        {workflowType === 'kubernetes' && !isFixing && (!isAnyRunning || isValidateRunning) ? (
          <Button
            onClick={handleValidate}
            disabled={isValidateRunning || isRefactorRunning}
            variant="default"
            className="flex-1"
            data-testid="button-validate"
          >
            {isValidateRunning ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Validating...
              </>
            ) : (
              <>
                <Wrench className="w-4 h-4 mr-2" />
                Validate
              </>
            )}
          </Button>
        ) : null}
      </div>

      {/* Show only the active view - one at a time */}
      {/* Security Scan - Hidden for aggregated-root Terraform modules (child module scanned separately) */}
      {activeView === 'security' && !(workflowType === 'terraform' && moduleApproach === 'aggregated-root') && (
        <CheckovScanner 
          ref={checkovRef}
          sessionId={sessionId}
          framework={workflowType === 'kubernetes' ? 'kubernetes' : workflowType === 'docker' ? 'docker' : 'terraform'}
          onScanComplete={(result) => {
            handleActivityComplete();
            onScanComplete?.(result);
          }}
          onScanStart={() => {
            setRunningActivity('security');
            setActiveView('security');
          }}
        />
      )}

      {activeView === 'cost' && (
        <CostAnalyzer 
          ref={costRef}
          sessionId={sessionId}
          onAnalysisComplete={() => {
            handleActivityComplete();
          }}
          onAnalysisStart={() => {
            setRunningActivity('cost');
            setActiveView('cost');
          }}
        />
      )}

      {/* Show RefactorValidator when active (Terraform) or KubernetesBestPractices (Kubernetes) */}
      {activeView === 'refactor' && workflowType === 'terraform' && (
        <RefactorValidator 
          ref={refactorRef}
          sessionId={sessionId}
          onValidationComplete={() => {
            handleActivityComplete();
          }}
          onValidationStart={() => {
            setRunningActivity('refactor');
            setActiveView('refactor');
          }}
          onFixStart={() => {
            setIsFixing(true);
            setRunningActivity(null); // Clear running activity to hide Best Approach button
          }}
          onFixComplete={() => {
            setIsFixing(false);
            // Restore all buttons by clearing running activity
            setRunningActivity(null);
            // Keep activeView as 'refactor' to show applied fixes, but buttons will be visible
            // The buttons are controlled by isFixing and isAnyRunning, not activeView
          }}
        />
      )}

      {/* Best Approach removed for Kubernetes workflow */}

      {/* Show KubernetesValidator when active */}
      {activeView === 'validate' && workflowType === 'kubernetes' && (
        <KubernetesValidator 
          ref={kubernetesValidatorRef}
          sessionId={sessionId}
          onValidationComplete={() => {
            handleActivityComplete();
          }}
          onValidationStart={() => {
            setRunningActivity('validate');
            setActiveView('validate');
          }}
        />
      )}

      {/* Show ArchitectureDiagram when active */}
      {activeView === 'diagram' && (
        <ArchitectureDiagram 
          ref={diagramRef}
          sessionId={sessionId}
          useArchMeEndpoint={false} // Use Terraform/Kubernetes endpoint, not ArchMe
          workflowType={workflowType}
          onDiagramComplete={() => {
            handleActivityComplete();
          }}
          onDiagramStart={() => {
            setRunningActivity('diagram');
            setActiveView('diagram');
          }}
        />
      )}

      {!activeView && (
        <div className="border rounded-lg p-8 text-center text-muted-foreground">
          <p>Select an activity above to get started</p>
        </div>
      )}
    </div>
  );
}

