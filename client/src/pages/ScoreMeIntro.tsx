import { useLocation } from "wouter";
import Header from "@/components/Header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowRight, Home } from "lucide-react";
import ScoreMeWalkthrough from "@/components/ScoreMeWalkthrough";

export default function ScoreMeIntro() {
  const [, setLocation] = useLocation();

  return (
    <div className="min-h-screen bg-background">
      <Header />

      <main className="container mx-auto px-6 py-12">
        <div className="max-w-4xl mx-auto space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold">ScoreMe Module</h1>
              <p className="text-muted-foreground mt-1">
                Quick overview before starting the ScoreMe workflow.
              </p>
            </div>
            <Button variant="outline" onClick={() => setLocation("/")}>
              <Home className="w-4 h-4 mr-2" />
              Home
            </Button>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>What ScoreMe Does</CardTitle>
              <CardDescription>
                ScoreMe analyzes your IaC and automation repository content, highlights findings,
                and generates a confidence report with actionable remediation guidance.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <p>- Select repository provider and project.</p>
              <p>- Run automated analysis across Terraform/Kubernetes/automation assets.</p>
              <p>- Review confidence score, findings, and downloadable ScoreSheet report.</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Walkthrough</CardTitle>
              <CardDescription>
                See how ScoreMe works step by step. Auto-plays every 5 seconds or use the controls to navigate.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ScoreMeWalkthrough />
            </CardContent>
          </Card>

          <div className="flex justify-end">
            <Button onClick={() => setLocation("/scoreme/app")}>
              Proceed to ScoreMe
              <ArrowRight className="w-4 h-4 ml-2" />
            </Button>
          </div>
        </div>
      </main>
    </div>
  );
}

