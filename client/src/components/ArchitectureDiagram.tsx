import { useState, forwardRef, useImperativeHandle, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Network, AlertCircle, Loader2, Copy, Download, RefreshCw, Search, ImageIcon } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import mermaid from "mermaid";

export type DiagramType = 'flowchart' | 'sequence' | 'state' | 'pie' | 'class' | 'mindmap' | 'gantt' | 'erDiagram' | 'journey' | 'gitGraph';

interface DiagramResource {
  type: string;
  name: string;
  file: string;
}

interface DiagramRelationship {
  from: string;
  to: string;
  type: string;
  description?: string;
}

interface DiagramMetadata {
  totalResources: number;
  totalRelationships: number;
  cloudProvider: string;
  categories: string[];
}

interface DiagramResult {
  success: boolean;
  mermaidSyntax: string;
  resources: DiagramResource[];
  relationships: DiagramRelationship[];
  metadata: DiagramMetadata;
}

interface ArchitectureDiagramProps {
  sessionId: string;
  onDiagramStart?: () => void;
  onDiagramComplete?: () => void;
  useArchMeEndpoint?: boolean; // If true, use generate-architecture-diagram endpoint
  workflowType?: 'terraform' | 'kubernetes'; // Add workflow type
}

export interface ArchitectureDiagramRef {
  triggerGenerate: () => void;
}

const ArchitectureDiagram = forwardRef<ArchitectureDiagramRef, ArchitectureDiagramProps>(
  ({ sessionId, onDiagramStart, onDiagramComplete, useArchMeEndpoint = false, workflowType = 'terraform' }, ref) => {
    const [isGenerating, setIsGenerating] = useState(false);
    const [diagramResult, setDiagramResult] = useState<DiagramResult | null>(null);
    const [renderError, setRenderError] = useState<string | null>(null);
    const [resourceFilter, setResourceFilter] = useState("");
    const [relationshipFilter, setRelationshipFilter] = useState("");
    const [diagramType, setDiagramType] = useState<DiagramType>('flowchart');
    const diagramRef = useRef<HTMLDivElement>(null);
    const mermaidInitialized = useRef(false);
    const { toast } = useToast();
    const previousDiagramType = useRef<DiagramType>('flowchart');
    const [enlargedSvg, setEnlargedSvg] = useState<string>("");
  const [isViewerOpen, setIsViewerOpen] = useState(false);
  const [isDownloadingJpg, setIsDownloadingJpg] = useState(false);

  const diagramTypeOptions: Array<{ value: DiagramType; label: string }> = [
    { value: 'flowchart', label: 'Flowchart (Architecture)' },
    { value: 'sequence', label: 'Sequence (Workflow)' },
    { value: 'state', label: 'State (Lifecycle)' },
    { value: 'pie', label: 'Pie Chart (Statistics)' },
    { value: 'class', label: 'Class (Hierarchy)' },
    { value: 'mindmap', label: 'Mindmap (Organization)' },
    { value: 'gantt', label: 'Gantt (Timeline)' },
    { value: 'erDiagram', label: 'ER Diagram (Entities)' },
    { value: 'journey', label: 'Journey (Experience)' },
    { value: 'gitGraph', label: 'Git Graph (Commits)' },
  ];

  // Initialize Mermaid
  useEffect(() => {
    if (!mermaidInitialized.current) {
      mermaid.initialize({
        startOnLoad: false,
        theme: 'default',
        securityLevel: 'loose',
        flowchart: {
          useMaxWidth: true,
          htmlLabels: true,
          curve: 'basis'
        }
      });
      mermaidInitialized.current = true;
    }
  }, []);

  // Auto-regenerate diagram when type changes (if diagram already exists)
  useEffect(() => {
    console.log('[DiagramType] Effect triggered:', { 
      diagramType, 
      previousType: previousDiagramType.current,
      hasResult: !!diagramResult,
      isGenerating 
    });
    
    // Only regenerate if we have a result and the type actually changed
    if (diagramResult && diagramType !== previousDiagramType.current) {
      if (isGenerating) {
        console.log('[DiagramType] Already generating, will regenerate after current generation completes');
        return;
      }
      console.log(`[DiagramType] Type changed from ${previousDiagramType.current} to ${diagramType}, regenerating...`);
      previousDiagramType.current = diagramType;
      // Use setTimeout to avoid state update during render
      setTimeout(() => {
        generateDiagram();
      }, 100);
    } else {
      // Update previous type even if we're not regenerating
      if (diagramType !== previousDiagramType.current) {
        previousDiagramType.current = diagramType;
      }
      if (diagramType === previousDiagramType.current) {
        console.log('[DiagramType] Type unchanged, skipping regeneration');
      } else if (!diagramResult) {
        console.log('[DiagramType] No diagram result yet, skipping regeneration');
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diagramType, diagramResult]);

  // Render Mermaid diagram when syntax changes
  useEffect(() => {
    if (diagramResult?.mermaidSyntax && diagramRef.current) {
    const renderDiagram = async () => {
        try {
          setRenderError(null);
          // Clear previous content
          diagramRef.current!.innerHTML = '';
          
          // Generate unique ID for this diagram
          const diagramId = `diagram-${Date.now()}`;
          
          // Render the diagram
          const { svg } = await mermaid.render(diagramId, diagramResult.mermaidSyntax);
          diagramRef.current!.innerHTML = svg;
          setEnlargedSvg(svg);
        } catch (error: any) {
          console.error('Mermaid rendering error:', error);
          setRenderError(error.message || 'Failed to render diagram');
          toast({
            title: "Diagram rendering failed",
            description: error.message || "Failed to render the architecture diagram",
            variant: "destructive",
          });
        }
    };

      renderDiagram();
    }
  }, [diagramResult?.mermaidSyntax, toast]);

  const generateDiagram = async () => {
    console.log('[generateDiagram] Starting generation with type:', diagramType);
    setIsGenerating(true);
    setRenderError(null);
    setDiagramResult(null);
    onDiagramStart?.();
    
    try {
      let endpoint: string;
      if (useArchMeEndpoint) {
        endpoint = `/api/sessions/${sessionId}/generate-architecture-diagram`;
      } else if (workflowType === 'kubernetes') {
        endpoint = `/api/sessions/${sessionId}/generate-kubernetes-diagram`;
      } else {
        endpoint = `/api/sessions/${sessionId}/generate-diagram`;
      }
      
      console.log('[generateDiagram] Calling endpoint:', endpoint);
      console.log('[generateDiagram] Request body:', { useAI: true, diagramType });
      
      const response = await apiRequest('POST', endpoint, {
        useAI: true,
        diagramType: diagramType
      });
      const result = await response.json() as DiagramResult;
      
      console.log('[generateDiagram] Received result:', {
        success: result.success,
        syntaxLength: result.mermaidSyntax?.length,
        resources: result.metadata?.totalResources,
        diagramType: diagramType
      });
      
      setDiagramResult(result);
      
      const resourceCount = result.metadata.totalResources || result.metadata.totalComponents || 0;
      const relationshipCount = result.metadata.totalRelationships || 0;
      
      toast({
        title: "Architecture diagram generated",
        description: `Found ${resourceCount} component(s) with ${relationshipCount} relationship(s)`,
      });
    } catch (error: any) {
      let errorMessage = error?.message || "Failed to generate architecture diagram";
      let errorDetails = "";
      
      // Try to parse error response
      const jsonMatch = errorMessage.match(/^\d+:\s*(\{.*\})/);
      if (jsonMatch) {
        try {
          const errorData = JSON.parse(jsonMatch[1]);
          errorMessage = errorData.error || errorMessage;
          errorDetails = errorData.details || "";
        } catch (e) {
          const textMatch = errorMessage.match(/^\d+:\s*(.+)/);
          if (textMatch) {
            errorMessage = textMatch[1];
          }
        }
      }
      
      console.error('Diagram generation error:', error);
      
      toast({
        title: "Generation failed",
        description: errorDetails ? `${errorMessage}: ${errorDetails}` : errorMessage,
        variant: "destructive",
      });
    } finally {
      setIsGenerating(false);
      onDiagramComplete?.();
    }
  };

  const handleDownloadJpg = async () => {
    if (!diagramResult?.mermaidSyntax || !diagramRef.current) {
      toast({
        title: "Download failed",
        description: "No diagram is ready yet",
        variant: "destructive",
      });
      return;
    }

    const svgElement = diagramRef.current.querySelector("svg");
    if (!svgElement) {
      toast({
        title: "Download failed",
        description: "No rendered diagram available",
        variant: "destructive",
      });
      return;
    }

    setIsDownloadingJpg(true);

    try {
      // For ArchMe workflow, use backend endpoint (which stores analysis)
      // For Terraform/Kubernetes, render SVG to canvas client-side
      if (useArchMeEndpoint) {
        const response = await fetch(`/api/sessions/${sessionId}/diagram-image`, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ diagramType }),
        });

        if (!response.ok) {
          const payload = await response.json().catch(() => null);
          throw new Error(
            payload?.details || payload?.message || payload?.error || response.statusText
          );
        }

        const blob = await response.blob();
        const link = document.createElement("a");
        const url = URL.createObjectURL(blob);
        link.href = url;
        link.download = `archme-diagram-${Date.now()}.jpg`;
        link.click();
        URL.revokeObjectURL(url);
      } else {
        // Client-side rendering for Terraform/Kubernetes diagrams
        // Get the actual rendered dimensions from the SVG
        const bbox = svgElement.getBoundingClientRect();
        const svgWidth = bbox.width || svgElement.clientWidth || 800;
        const svgHeight = bbox.height || svgElement.clientHeight || 600;

        // Clone the SVG and set explicit dimensions
        const svgClone = svgElement.cloneNode(true) as SVGSVGElement;
        svgClone.setAttribute('width', String(svgWidth));
        svgClone.setAttribute('height', String(svgHeight));

        // Ensure viewBox is set if not present
        if (!svgClone.getAttribute('viewBox')) {
          svgClone.setAttribute('viewBox', `0 0 ${svgWidth} ${svgHeight}`);
        }

        // Serialize the cloned SVG with explicit dimensions
        const svgData = new XMLSerializer().serializeToString(svgClone);

        // Encode SVG to base64 data URL (avoids cross-origin tainting)
        const svgBase64 = btoa(unescape(encodeURIComponent(svgData)));
        const dataUrl = `data:image/svg+xml;base64,${svgBase64}`;

        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          // Scale up for better quality
          const scale = 2;
          // Use the known dimensions, not img.width/height which may be 0
          const width = img.naturalWidth || svgWidth;
          const height = img.naturalHeight || svgHeight;
          canvas.width = width * scale;
          canvas.height = height * scale;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            // Fill with white background for better visibility
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.scale(scale, scale);
            ctx.drawImage(img, 0, 0, width, height);

            canvas.toBlob((blob) => {
              if (blob) {
                const link = document.createElement('a');
                const url = URL.createObjectURL(blob);
                link.href = url;
                link.download = `${workflowType}-diagram-${Date.now()}.jpg`;
                link.click();
                URL.revokeObjectURL(url);
              }
              setIsDownloadingJpg(false);
            }, 'image/jpeg', 0.95);
          } else {
            setIsDownloadingJpg(false);
          }
        };
        img.onerror = () => {
          toast({
            title: "Download failed",
            description: "Failed to render diagram image",
            variant: "destructive",
          });
          setIsDownloadingJpg(false);
        };
        img.src = dataUrl;
        return; // Early return - callback will handle setIsDownloadingJpg
      }
    } catch (error: any) {
      toast({
        title: "Download failed",
        description: error?.message || "Unable to export diagram",
        variant: "destructive",
      });
    } finally {
      if (useArchMeEndpoint) {
        setIsDownloadingJpg(false);
      }
    }
  };

  useImperativeHandle(ref, () => ({
    triggerGenerate: generateDiagram
  }));

  // Copy Mermaid syntax to clipboard
  const copyMermaidSyntax = async () => {
    if (!diagramResult?.mermaidSyntax) return;
    
    try {
      await navigator.clipboard.writeText(diagramResult.mermaidSyntax);
      toast({
        title: "Copied to clipboard",
        description: "Mermaid syntax copied to clipboard",
      });
    } catch (error) {
      toast({
        title: "Copy failed",
        description: "Failed to copy to clipboard",
        variant: "destructive",
      });
    }
  };

  // Filter resources
  const filteredResources = diagramResult?.resources.filter(resource => {
    if (!resourceFilter) return true;
    const filter = resourceFilter.toLowerCase();
    return (
      resource.type.toLowerCase().includes(filter) ||
      resource.name.toLowerCase().includes(filter) ||
      resource.file.toLowerCase().includes(filter)
    );
  }) || [];

  // Filter relationships
  const filteredRelationships = diagramResult?.relationships.filter(rel => {
    if (!relationshipFilter) return true;
    const filter = relationshipFilter.toLowerCase();
    return (
      rel.from.toLowerCase().includes(filter) ||
      rel.to.toLowerCase().includes(filter) ||
      rel.type.toLowerCase().includes(filter) ||
      (rel.description && rel.description.toLowerCase().includes(filter))
    );
  }) || [];

  return (
    <div className="w-full space-y-4">
      {/* Loading state overlay */}
      {isGenerating && (
        <Card className="p-6 border border-dashed border-blue-200 bg-blue-50 text-center">
          <div className="flex flex-col items-center gap-2">
            <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
            <p className="text-lg font-semibold text-blue-900">Regenerating architecture diagram</p>
            <p className="text-sm text-blue-800/80">
              Please wait while we analyze your input and render the updated diagram type (<strong>{diagramType}</strong>).
            </p>
          </div>
        </Card>
      )}

      {!isGenerating && !diagramResult && (
        <Card className="p-4">
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                Diagram Type:
              </label>
              <Select
                value={diagramType}
                onValueChange={(value) => setDiagramType(value as DiagramType)}
              >
                <SelectTrigger className="w-[220px]">
                  <SelectValue placeholder="Select type" />
                </SelectTrigger>
                <SelectContent>
                  {diagramTypeOptions.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex gap-2 ml-auto">
              <Button
                variant="default"
                size="sm"
                onClick={generateDiagram}
                disabled={isGenerating}
              >
                <Network className="w-4 h-4 mr-2" />
                Generate Diagram
              </Button>
            </div>
          </div>
        </Card>
      )}

      {!isGenerating && diagramResult && (
        <div className="space-y-4">
          {/* Diagram Type Selector & Controls */}
          <Card className="p-4">
            <div className="flex flex-wrap items-center gap-4">
              <div className="flex items-center gap-2">
                <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  Diagram Type:
                </label>
                <Select 
                  value={diagramType} 
                  onValueChange={(value) => {
                    console.log('[Select] Diagram type changed from', diagramType, 'to', value);
                    setDiagramType(value as DiagramType);
                  }}
                >
                  <SelectTrigger className="w-[180px]">
                    <SelectValue placeholder="Select type" />
                  </SelectTrigger>
                  <SelectContent>
                    {diagramTypeOptions.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex gap-2 ml-auto">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={generateDiagram}
                  disabled={isGenerating}
                >
                  {isGenerating ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Regenerating...
                    </>
                  ) : (
                    <>
                      <RefreshCw className="w-4 h-4 mr-2" />
                      Regenerate
                    </>
                  )}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={copyMermaidSyntax}
                  disabled={!diagramResult?.mermaidSyntax}
                >
                  <Copy className="w-4 h-4 mr-2" />
                  Copy Syntax
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleDownloadJpg}
                  disabled={!diagramResult?.mermaidSyntax || isDownloadingJpg}
                >
                  {isDownloadingJpg ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Downloading JPG...
                    </>
                  ) : (
                    <>
                      <ImageIcon className="w-4 h-4 mr-2" />
                      Download JPG
                    </>
                  )}
                </Button>
              </div>
            </div>
          </Card>

          {isViewerOpen &&
            createPortal(
              (
                <div className="fixed inset-0 bg-black/80 z-[9999] flex items-center justify-center">
                  <div className="relative w-full h-full">
                    <button
                      onClick={() => setIsViewerOpen(false)}
                      className="absolute right-4 top-4 z-20 text-xs font-semibold px-3 py-1 rounded bg-red-600 text-white"
                    >
                      Close
                    </button>
                    <div
                      className="absolute inset-0 p-6 overflow-auto bg-white dark:bg-gray-950"
                      dangerouslySetInnerHTML={{ __html: enlargedSvg }}
                    />
                  </div>
                </div>
              ),
              document.body
            )}

          {/* Metadata Summary */}
          <Card className="p-4 bg-blue-50 dark:bg-blue-950 border-blue-200 dark:border-blue-800">
            <div className="flex items-center gap-2 mb-3">
              <Network className="w-5 h-5 text-blue-600 dark:text-blue-400" />
              <h4 className="font-semibold text-gray-900 dark:text-gray-100">
                Architecture Overview
              </h4>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div>
                <div className="text-2xl font-bold text-gray-900 dark:text-gray-100">
                  {(diagramResult.metadata as any).totalResources
                    || (diagramResult.metadata as any).totalComponents
                    || diagramResult.resources?.length
                    || 0}
                </div>
                <div className="text-xs text-gray-600 dark:text-gray-400">Resources</div>
              </div>
              <div>
                <div className="text-2xl font-bold text-gray-900 dark:text-gray-100">
                  {diagramResult.metadata.totalRelationships || diagramResult.relationships?.length || 0}
                </div>
                <div className="text-xs text-gray-600 dark:text-gray-400">Relationships</div>
              </div>
              <div>
                <div className="text-sm font-semibold text-gray-900 dark:text-gray-100 capitalize">
                  {diagramResult.metadata.cloudProvider}
                </div>
                <div className="text-xs text-gray-600 dark:text-gray-400">Cloud Provider</div>
              </div>
              <div>
                <div className="flex flex-wrap gap-1">
                  {diagramResult.metadata.categories.map((cat, idx) => (
                    <Badge key={idx} variant="outline" className="text-xs">
                      {cat}
                    </Badge>
                  ))}
                </div>
                <div className="text-xs text-gray-600 dark:text-gray-400 mt-1">Categories</div>
              </div>
            </div>
          </Card>

          {/* Diagram */}
          <Card className="p-4">
            <div className="flex items-center justify-between mb-3">
              <h4 className="font-semibold text-gray-900 dark:text-gray-100">
                {diagramType === 'flowchart' ? 'Architecture Diagram' :
                 diagramType === 'sequence' ? 'Sequence Diagram' :
                 diagramType === 'state' ? 'State Diagram' :
                 diagramType === 'pie' ? 'Pie Chart' :
                 diagramType === 'class' ? 'Class Diagram' :
                 diagramType === 'mindmap' ? 'Mindmap' :
                 diagramType === 'gantt' ? 'Gantt Chart' :
                 diagramType === 'erDiagram' ? 'Entity-Relationship Diagram' :
                 diagramType === 'journey' ? 'Journey Diagram' :
                 diagramType === 'gitGraph' ? 'Git Graph' :
                 'Diagram'}
              </h4>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setIsViewerOpen(true)}
                disabled={!diagramResult?.mermaidSyntax}
              >
                View
              </Button>
            </div>
            {renderError ? (
              <Alert variant="destructive">
                <AlertCircle className="w-4 h-4" />
                <AlertTitle>Rendering Error</AlertTitle>
                <AlertDescription>{renderError}</AlertDescription>
              </Alert>
            ) : (
              <div className="border rounded-lg p-4 bg-white dark:bg-gray-900 overflow-auto">
                <div 
                  ref={diagramRef} 
                  className="mermaid-diagram flex justify-center items-center min-h-[400px]"
                />
              </div>
            )}
          </Card>

          {/* Resources Table */}
          {diagramResult.resources.length > 0 && (
            <Card className="p-4">
              <div className="flex items-center justify-between mb-3">
                <h4 className="font-semibold text-gray-900 dark:text-gray-100">
                  Resources ({filteredResources.length} of {diagramResult.resources.length})
                </h4>
                <div className="relative w-64">
                  <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Filter resources..."
                    value={resourceFilter}
                    onChange={(e) => setResourceFilter(e.target.value)}
                    className="pl-8"
                  />
                </div>
              </div>
              <ScrollArea className="h-[300px]">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Resource Type</TableHead>
                      <TableHead>Resource Name</TableHead>
                      <TableHead>File</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredResources.length > 0 ? (
                      filteredResources.map((resource, idx) => (
                        <TableRow key={idx}>
                          <TableCell>
                            <code className="text-xs bg-gray-100 dark:bg-gray-800 px-2 py-1 rounded">
                              {resource.type}
                            </code>
                          </TableCell>
                          <TableCell className="font-medium">{resource.name}</TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {resource.file}
                          </TableCell>
                        </TableRow>
                      ))
                    ) : (
                      <TableRow>
                        <TableCell colSpan={3} className="text-center text-muted-foreground">
                          No resources match the filter
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </ScrollArea>
            </Card>
          )}

          {/* Relationships Table */}
          {diagramResult.relationships.length > 0 && (
            <Card className="p-4">
              <div className="flex items-center justify-between mb-3">
                <h4 className="font-semibold text-gray-900 dark:text-gray-100">
                  Relationships ({filteredRelationships.length} of {diagramResult.relationships.length})
                </h4>
                <div className="relative w-64">
                  <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Filter relationships..."
                    value={relationshipFilter}
                    onChange={(e) => setRelationshipFilter(e.target.value)}
                    className="pl-8"
                  />
                </div>
              </div>
              <ScrollArea className="h-[300px]">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>From</TableHead>
                      <TableHead>To</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Description</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredRelationships.length > 0 ? (
                      filteredRelationships.map((rel, idx) => (
                        <TableRow key={idx}>
                          <TableCell>
                            <code className="text-xs bg-gray-100 dark:bg-gray-800 px-2 py-1 rounded">
                              {rel.from}
                            </code>
                          </TableCell>
                          <TableCell>
                            <code className="text-xs bg-gray-100 dark:bg-gray-800 px-2 py-1 rounded">
                              {rel.to}
                            </code>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className="text-xs">
                              {rel.type}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {rel.description || '-'}
                          </TableCell>
                        </TableRow>
                      ))
                    ) : (
                      <TableRow>
                        <TableCell colSpan={4} className="text-center text-muted-foreground">
                          No relationships match the filter
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </ScrollArea>
            </Card>
          )}
        </div>
      )}

      {!diagramResult && !isGenerating && (
        <Alert>
          <AlertCircle className="w-4 h-4" />
          <AlertTitle>No Diagram Generated</AlertTitle>
          <AlertDescription>
            Select a diagram type and click "Generate Diagram" to build your architecture view.
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
});

ArchitectureDiagram.displayName = 'ArchitectureDiagram';

export default ArchitectureDiagram;

