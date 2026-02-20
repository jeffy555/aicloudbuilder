import { useLocation } from "wouter";
import Header from "@/components/Header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowRight, Home } from "lucide-react";

export default function AutomationIntro() {
  const [, setLocation] = useLocation();

  return (
    <div className="min-h-screen bg-background">
      <Header />

      <main className="container mx-auto px-6 py-12">
        <div className="max-w-4xl mx-auto space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold">Automation Scripts Module</h1>
              <p className="text-muted-foreground mt-1">
                Quick overview before starting the automation workflow.
              </p>
            </div>
            <Button variant="outline" onClick={() => setLocation("/")}>
              <Home className="w-4 h-4 mr-2" />
              Home
            </Button>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>What Automation Module Does</CardTitle>
              <CardDescription>
                Automation module helps generate task-driven scripts for operational workflows
                and CI/CD style automation in your repository context.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <p>- Select language and repository context.</p>
              <p>- Describe the automation requirement.</p>
              <p>- Generate, review, and proceed with script publication.</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Quick Walkthrough Video</CardTitle>
              <CardDescription>
                Watch this short video, then click Proceed to continue.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-hidden rounded-xl border border-border/60 bg-black">
                <video
                  controls
                  preload="metadata"
                  className="w-full h-auto"
                  src="/videos/2025-12-30T18-16-20_cinematic_close_up_watermarked.mp4"
                >
                  Your browser does not support the video tag.
                </video>
              </div>
            </CardContent>
          </Card>

          <div className="flex justify-end">
            <Button onClick={() => setLocation("/automation/app")}>
              Proceed to Automation
              <ArrowRight className="w-4 h-4 ml-2" />
            </Button>
          </div>
        </div>
      </main>
    </div>
  );
}


