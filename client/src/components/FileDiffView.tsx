import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { FileCode, Plus, Minus } from "lucide-react";

interface FileDiff {
  fileName: string;
  originalContent: string;
  fixedContent: string;
}

interface FileDiffViewProps {
  diffs: FileDiff[];
}

// Simple diff algorithm - shows line-by-line comparison
function computeDiff(original: string, fixed: string): Array<{ type: 'added' | 'removed' | 'unchanged'; line: string }> {
  const originalLines = original.split('\n');
  const fixedLines = fixed.split('\n');
  const diff: Array<{ type: 'added' | 'removed' | 'unchanged'; line: string }> = [];
  
  const maxLines = Math.max(originalLines.length, fixedLines.length);
  
  for (let i = 0; i < maxLines; i++) {
    const originalLine = originalLines[i] || '';
    const fixedLine = fixedLines[i] || '';
    
    if (originalLine === fixedLine) {
      diff.push({ type: 'unchanged', line: originalLine });
    } else {
      if (originalLine && !fixedLine) {
        diff.push({ type: 'removed', line: originalLine });
      } else if (!originalLine && fixedLine) {
        diff.push({ type: 'added', line: fixedLine });
      } else {
        // Line changed
        diff.push({ type: 'removed', line: originalLine });
        diff.push({ type: 'added', line: fixedLine });
      }
    }
  }
  
  return diff;
}

export default function FileDiffView({ diffs }: FileDiffViewProps) {
  if (diffs.length === 0) {
    return null;
  }

  return (
    <div className="space-y-4">
      {diffs.map((diff, index) => {
        const lineDiffs = computeDiff(diff.originalContent, diff.fixedContent);
        const addedLines = lineDiffs.filter(d => d.type === 'added').length;
        const removedLines = lineDiffs.filter(d => d.type === 'removed').length;
        
        return (
          <Card key={index}>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <FileCode className="w-5 h-5 text-muted-foreground" />
                  <CardTitle className="text-lg">{diff.fileName}</CardTitle>
                </div>
                <div className="flex gap-2">
                  {removedLines > 0 && (
                    <Badge variant="destructive" className="flex items-center gap-1">
                      <Minus className="w-3 h-3" />
                      {removedLines} removed
                    </Badge>
                  )}
                  {addedLines > 0 && (
                    <Badge variant="default" className="flex items-center gap-1 bg-green-600">
                      <Plus className="w-3 h-3" />
                      {addedLines} added
                    </Badge>
                  )}
                </div>
              </div>
              <CardDescription>
                Changes made to fix security issues
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-[400px] rounded-md border">
                <div className="p-4 font-mono text-sm">
                  {lineDiffs.map((lineDiff, lineIndex) => (
                    <div
                      key={lineIndex}
                      className={`flex ${
                        lineDiff.type === 'added'
                          ? 'bg-green-50 dark:bg-green-950 border-l-4 border-green-500'
                          : lineDiff.type === 'removed'
                          ? 'bg-red-50 dark:bg-red-950 border-l-4 border-red-500'
                          : 'bg-transparent'
                      }`}
                    >
                      <div className="w-8 text-right pr-2 text-muted-foreground text-xs flex-shrink-0">
                        {lineDiff.type === 'added' ? '+' : lineDiff.type === 'removed' ? '-' : ' '}
                      </div>
                      <div className="flex-1 overflow-x-auto">
                        <pre className="whitespace-pre-wrap break-words">
                          {lineDiff.line || ' '}
                        </pre>
                      </div>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}




