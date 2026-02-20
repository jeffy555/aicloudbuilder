import { useLocation } from "wouter";
import Header from "@/components/Header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowRight, Home } from "lucide-react";

export default function KubernetesIntro() {
  const [, setLocation] = useLocation();

  return (
    <div className="min-h-screen bg-background">
      <Header />

      <main className="container mx-auto px-6 py-12">
        <div className="max-w-4xl mx-auto space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold">Kubernetes Module</h1>
              <p className="text-muted-foreground mt-1">
                Quick overview before starting the Kubernetes workflow.
              </p>
            </div>
            <Button variant="outline" onClick={() => setLocation("/")}>
              <Home className="w-4 h-4 mr-2" />
              Home
            </Button>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>What Kubernetes Module Does</CardTitle>
              <CardDescription>
                Kubernetes module helps build and validate deployment manifests with
                built-in best-practice and security-oriented checks.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <p>- Capture workload intent and target setup.</p>
              <p>- Generate Kubernetes YAML/manifests.</p>
              <p>- Validate, scan, remediate findings, and prepare for commit.</p>
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
            <Button onClick={() => setLocation("/kubernetes/app")}>
              Proceed to Kubernetes
              <ArrowRight className="w-4 h-4 ml-2" />
            </Button>
          </div>
        </div>
      </main>
    </div>
  );
}


