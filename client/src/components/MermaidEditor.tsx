import { useState, useEffect, useRef, useCallback } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertCircle, Check, Copy } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import mermaid from "mermaid";

interface MermaidEditorProps {
  initialSyntax: string;
  onSyntaxChange?: (syntax: string) => void;
}

export default function MermaidEditor({ initialSyntax, onSyntaxChange }: MermaidEditorProps) {
  const [syntax, setSyntax] = useState(initialSyntax);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [isValid, setIsValid] = useState(true);
  const previewRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const mermaidInitialized = useRef(false);
  const { toast } = useToast();

  useEffect(() => {
    if (!mermaidInitialized.current) {
      mermaid.initialize({
        startOnLoad: false,
        theme: 'default',
        securityLevel: 'strict',
        flowchart: { useMaxWidth: true, htmlLabels: false, curve: 'basis' }
      });
      mermaidInitialized.current = true;
    }
  }, []);

  const renderPreview = useCallback(async (code: string) => {
    if (!previewRef.current || !code.trim()) return;

    try {
      setRenderError(null);
      previewRef.current.innerHTML = '';
      const diagramId = `mermaid-editor-${Date.now()}`;
      const { svg } = await mermaid.render(diagramId, code.trim());
      if (previewRef.current) {
        previewRef.current.innerHTML = svg;
      }
      setIsValid(true);
    } catch (error: any) {
      setRenderError(error.message || 'Invalid Mermaid syntax');
      setIsValid(false);
    }
  }, []);

  // Debounced re-render on syntax change
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      renderPreview(syntax);
      onSyntaxChange?.(syntax);
    }, 400);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [syntax, renderPreview, onSyntaxChange]);

  // Initial render
  useEffect(() => {
    renderPreview(initialSyntax);
  }, [initialSyntax, renderPreview]);

  // Sync external changes
  useEffect(() => {
    setSyntax(initialSyntax);
  }, [initialSyntax]);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {/* Editor Panel */}
      <Card className="p-0 overflow-hidden">
        <div className="px-3 py-2 border-b bg-muted/50 flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground">Mermaid Editor</span>
          <div className="flex items-center gap-2">
            {isValid ? (
              <span className="flex items-center gap-1 text-xs text-emerald-600"><Check className="w-3 h-3" /> Valid</span>
            ) : (
              <span className="flex items-center gap-1 text-xs text-red-500"><AlertCircle className="w-3 h-3" /> Error</span>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2"
              onClick={async () => {
                await navigator.clipboard.writeText(syntax);
                toast({ title: "Copied", description: "Mermaid syntax copied to clipboard" });
              }}
            >
              <Copy className="w-3 h-3" />
            </Button>
          </div>
        </div>
        <textarea
          value={syntax}
          onChange={(e) => setSyntax(e.target.value)}
          className="w-full h-[500px] p-3 font-mono text-xs bg-background resize-none focus:outline-none border-0"
          spellCheck={false}
          placeholder="Enter Mermaid diagram syntax..."
        />
      </Card>

      {/* Preview Panel */}
      <Card className="p-0 overflow-hidden">
        <div className="px-3 py-2 border-b bg-muted/50">
          <span className="text-xs font-medium text-muted-foreground">Live Preview</span>
        </div>
        <div className="p-4 min-h-[500px] overflow-auto bg-white dark:bg-gray-900">
          {renderError ? (
            <Alert variant="destructive" className="mb-4">
              <AlertCircle className="w-4 h-4" />
              <AlertDescription className="text-xs">{renderError}</AlertDescription>
            </Alert>
          ) : null}
          <div
            ref={previewRef}
            className="mermaid-preview flex justify-center items-start min-h-[400px]"
          />
        </div>
      </Card>
    </div>
  );
}
