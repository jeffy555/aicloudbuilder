import { useLocation } from "wouter";
import Header from "@/components/Header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowRight, Home } from "lucide-react";
import DockerWalkthrough from "@/components/DockerWalkthrough";

export default function DockerIntro() {
  const [, setLocation] = useLocation();

  return (
    <div className="min-h-screen bg-background">
      <Header />

      <main className="container mx-auto px-6 py-12">
        <div className="max-w-4xl mx-auto space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold">Docker Module</h1>
              <p className="text-muted-foreground mt-1">
                Quick overview before starting the Docker workflow.
              </p>
            </div>
            <Button variant="outline" onClick={() => setLocation("/")}>
              <Home className="w-4 h-4 mr-2" />
              Home
            </Button>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>What Docker Module Does</CardTitle>
              <CardDescription>
                Docker module generates optimized and secure Docker artifacts based on your
                application and deployment requirements.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <p>- Describe your software and runtime requirements.</p>
              <p>- Generate Dockerfiles and related artifacts.</p>
              <p>- Review output, scan findings, and prepare for repository publication.</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Walkthrough</CardTitle>
              <CardDescription>
                See how the Docker workflow works step by step. Auto-plays every 5 seconds or use the controls to navigate.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <DockerWalkthrough />
            </CardContent>
          </Card>

          <div className="flex justify-end">
            <Button onClick={() => setLocation("/docker/app")}>
              Proceed to Docker
              <ArrowRight className="w-4 h-4 ml-2" />
            </Button>
          </div>
        </div>
      </main>
    </div>
  );
}

