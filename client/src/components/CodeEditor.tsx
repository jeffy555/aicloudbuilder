import { useState } from "react";
import { Card } from "@/components/ui/card";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { FileTextIcon } from "@radix-ui/react-icons";
import { FolderIcon } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";

interface CodeFile {
  name: string;
  content: string;
}

interface CodeEditorProps {
  files: CodeFile[];
  onFileChange: (fileName: string, content: string) => void;
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

export default function CodeEditor({ files, onFileChange }: CodeEditorProps) {
  const [selectedFile, setSelectedFile] = useState<string>(files[0]?.name || '');
  const fileGroups = groupFilesByFolder(files);
  const currentFile = files.find(f => f.name === selectedFile);

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      {/* File List Panel */}
      <Card className="p-4 md:col-span-1">
        <h3 className="text-lg font-semibold mb-4">Generated Files</h3>
        <ScrollArea className="h-[500px] pr-4">
          <RadioGroup value={selectedFile} onValueChange={setSelectedFile}>
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
        <div className="mb-4">
          <h3 className="text-lg font-semibold mb-1">Code Preview</h3>
          {currentFile && (
            <p className="text-sm text-muted-foreground font-mono">{currentFile.name}</p>
          )}
        </div>
        
        {currentFile ? (
          <Textarea
            value={currentFile.content}
            onChange={(e) => onFileChange(currentFile.name, e.target.value)}
            className="min-h-[450px] font-mono text-sm resize-none"
            placeholder={`Edit ${currentFile.name}...`}
            data-testid={`editor-${currentFile.name}`}
          />
        ) : (
          <div className="min-h-[450px] flex items-center justify-center text-muted-foreground">
            <p>Select a file to preview</p>
          </div>
        )}
      </Card>
    </div>
  );
}
