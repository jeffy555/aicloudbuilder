import { useState } from "react";
import { useLocation } from "wouter";
import Header from "@/components/Header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ArrowRight, RefreshCw, FileCode, CheckCircle2, PlayCircle } from "lucide-react";

export default function MigrateOpsIntro() {
  const [, setLocation] = useLocation();

  return (
    <div className="min-h-screen bg-background flex flex-col font-sans">
      <Header />
      <main className="flex-1 container mx-auto px-4 py-8">
        <div className="max-w-4xl mx-auto space-y-8">
          {/* Hero Section */}
          <div className="text-center space-y-4">
            <div className="inline-flex items-center justify-center p-3 bg-primary/10 rounded-full mb-4">
              <RefreshCw className="w-8 h-8 text-primary" />
            </div>
            <h1 className="text-4xl font-bold tracking-tight">MigrateOps</h1>
            <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
              Reverse-engineer your live, manually-created cloud environments into clean, managed Terraform code with auto-generated state imports.
            </p>
          </div>

          {/* Action Card */}
          <Card className="bg-card border-primary/20 shadow-lg">
            <CardContent className="p-8 flex flex-col items-center text-center space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6 w-full text-left mb-4">
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-primary font-medium">
                    <RefreshCw className="w-5 h-5" />
                    <span>Extract</span>
                  </div>
                  <p className="text-sm text-muted-foreground">Scan live Azure Resource Groups and pull existing configurations.</p>
                </div>
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-primary font-medium">
                    <FileCode className="w-5 h-5" />
                    <span>Translate</span>
                  </div>
                  <p className="text-sm text-muted-foreground">AI converts raw cloud JSON into best-practice Terraform HCL.</p>
                </div>
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-primary font-medium">
                    <CheckCircle2 className="w-5 h-5" />
                    <span>Import</span>
                  </div>
                  <p className="text-sm text-muted-foreground">Automatically generates import blocks to seamlessly adopt live state.</p>
                </div>
              </div>

              <Button 
                size="lg" 
                className="w-full sm:w-auto text-lg px-8 py-6 h-auto"
                onClick={() => setLocation('/migrateops/app')}
              >
                <PlayCircle className="w-6 h-6 mr-2" />
                Proceed to MigrateOps
                <ArrowRight className="w-5 h-5 ml-2" />
              </Button>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}