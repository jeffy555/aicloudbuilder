import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FileTextIcon } from "@radix-ui/react-icons";
import { Textarea } from "@/components/ui/textarea";

interface CodeFile {
  name: string;
  content: string;
}

interface CodeEditorProps {
  files: CodeFile[];
  onFileChange: (fileName: string, content: string) => void;
}

export default function CodeEditor({ files, onFileChange }: CodeEditorProps) {
  return (
    <Card className="p-4">
      <h3 className="text-lg font-medium mb-4">Generated Terraform Files</h3>
      <Tabs defaultValue={files[0]?.name} className="w-full">
        <TabsList className="w-full justify-start mb-4">
          {files.map((file) => (
            <TabsTrigger 
              key={file.name} 
              value={file.name}
              className="gap-2 font-mono text-sm"
              data-testid={`tab-file-${file.name}`}
            >
              <FileTextIcon className="w-4 h-4" />
              {file.name}
            </TabsTrigger>
          ))}
        </TabsList>
        {files.map((file) => (
          <TabsContent key={file.name} value={file.name} className="mt-0">
            <Textarea
              value={file.content}
              onChange={(e) => onFileChange(file.name, e.target.value)}
              className="min-h-[400px] font-mono text-sm resize-none"
              placeholder={`Edit ${file.name}...`}
              data-testid={`editor-${file.name}`}
            />
          </TabsContent>
        ))}
      </Tabs>
    </Card>
  );
}
