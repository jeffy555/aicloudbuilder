import { useState, useEffect } from "react";
import { Card } from "@/components/ui/card";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { FileTextIcon } from "@radix-ui/react-icons";
import { Check, Copy, FolderIcon } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

interface CodeFile {
  name: string;
  content: string;
}

interface CodeEditorProps {
  files: CodeFile[];
  onFileChange: (fileName: string, content: string) => void;
  existingFiles?: string[]; // List of existing file paths (read-only)
  activeFile?: string;
  onFileSelect?: (fileName: string) => void;
}

/** One row per path; last occurrence wins (matches server "newest" dedupe). */
function dedupeFilesByPath(files: CodeFile[]): CodeFile[] {
  const map = new Map<string, CodeFile>();
  for (const f of files) {
    map.set(f.name.toLowerCase(), f);
  }
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}

// Group files by folder for better organization
function groupFilesByFolder(files: CodeFile[]): Map<string, CodeFile[]> {
  const groups = new Map<string, CodeFile[]>();
  
  files.forEach(file => {
    const parts = file.name.split('/');
    const folder = parts.length > 1 ? parts[0] : 'Root Files';
    
    if (!groups.has(folder)) {
      groups.set(folder, []);
    }
    groups.get(folder)!.push(file);
  });
  
  return groups;
}

export default function CodeEditor({ files, onFileChange, existingFiles = [], activeFile, onFileSelect }: CodeEditorProps) {
  const { toast } = useToast();
  const filesDeduped = dedupeFilesByPath(files);
  const [selectedFile, setSelectedFile] = useState<string>(filesDeduped[0]?.name || '');
  const [justCopied, setJustCopied] = useState(false);
  useEffect(() => {
    setSelectedFile((prev) => {
      if (activeFile && filesDeduped.some((file) => file.name === activeFile)) {
        return activeFile;
      }
      if (filesDeduped.some((file) => file.name === prev)) {
        return prev;
      }
      return filesDeduped[0]?.name || '';
    });
  }, [activeFile, filesDeduped]);
  const fileGroups = groupFilesByFolder(filesDeduped);
  const currentFile = filesDeduped.find(f => f.name === selectedFile);
  const isExistingFile = currentFile ? existingFiles.includes(currentFile.name) : false;

  const handleCopyCurrentFile = async () => {
    if (!currentFile?.content) {
      toast({
        title: "Nothing to copy",
        description: "Select a file with content first.",
        variant: "destructive",
      });
      return;
    }

    try {
      await navigator.clipboard.writeText(currentFile.content);
      setJustCopied(true);
      setTimeout(() => setJustCopied(false), 1200);
      toast({
        title: "Copied",
        description: `${currentFile.name} copied to clipboard.`,
      });
    } catch (error) {
      toast({
        title: "Copy failed",
        description: "Clipboard access was blocked by the browser.",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      {/* File List Panel */}
      <Card className="p-4 md:col-span-1">
        <h3 className="text-lg font-semibold mb-4">Repository Files</h3>
        <ScrollArea className="h-[500px] pr-4">
        <RadioGroup value={selectedFile} onValueChange={(value) => {
          setSelectedFile(value);
          onFileSelect?.(value);
        }}>
            {Array.from(fileGroups.entries()).map(([folder, folderFiles], groupIndex) => (
              <div key={folder} className="mb-4">
                {/* Folder Header */}
                <div className="flex items-center gap-2 mb-2 text-sm font-medium text-muted-foreground">
                  <FolderIcon className="w-4 h-4" />
                  <span>{folder}</span>
                </div>
                
                {/* Files in folder */}
                <div className="ml-6 space-y-2">
                  {folderFiles.map((file, fileIndex) => {
                    const fileName = file.name.split('/').pop() || file.name;
                    return (
                      <div
                        key={file.name}
                        className="flex items-center space-x-2 p-2 rounded-md hover-elevate cursor-pointer"
                        onClick={() => setSelectedFile(file.name)}
                        data-testid={`file-list-item-${file.name}`}
                      >
                        <RadioGroupItem 
                          value={file.name} 
                          id={file.name}
                          data-testid={`radio-file-${file.name}`}
                        />
                        <Label
                          htmlFor={file.name}
                          className="flex items-center gap-2 cursor-pointer flex-1 font-mono text-sm"
                        >
                          <FileTextIcon className="w-4 h-4" />
                          <span>{fileName}</span>
                          {existingFiles.includes(file.name) && (
                            <span className="text-xs text-muted-foreground ml-auto">(existing)</span>
                          )}
                        </Label>
                      </div>
                    );
                  })}
                </div>
                
                {groupIndex < fileGroups.size - 1 && (
                  <Separator className="mt-4" />
                )}
              </div>
            ))}
          </RadioGroup>
        </ScrollArea>
      </Card>

      {/* Code View Panel */}
      <Card className="p-4 md:col-span-2">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold mb-1">Code Preview</h3>
            {currentFile && (
              <p className="text-sm text-muted-foreground font-mono">{currentFile.name}</p>
            )}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleCopyCurrentFile}
            disabled={!currentFile}
            data-testid="copy-code-preview"
          >
            {justCopied ? (
              <>
                <Check className="w-4 h-4 mr-2" />
                Copied
              </>
            ) : (
              <>
                <Copy className="w-4 h-4 mr-2" />
                Copy
              </>
            )}
          </Button>
        </div>
        
        {currentFile ? (
          <>
            {isExistingFile && (
              <div className="mb-2 text-xs text-muted-foreground bg-muted/50 p-2 rounded">
                This is an existing file in the repository. Only the generated automation script can be edited.
              </div>
            )}
            <Textarea
              value={currentFile.content}
              onChange={(e) => onFileChange(currentFile.name, e.target.value)}
              className="min-h-[450px] font-mono text-sm resize-none"
              placeholder={`Edit ${currentFile.name}...`}
              data-testid={`editor-${currentFile.name}`}
              readOnly={isExistingFile}
            />
          </>
        ) : (
          <div className="min-h-[450px] flex items-center justify-center text-muted-foreground">
            <p>Select a file to preview</p>
          </div>
        )}
      </Card>
    </div>
  );
}
