import { useLocation } from "wouter";
import Header from "@/components/Header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowRight, Home } from "lucide-react";
import ValuationWalkthrough from "@/components/ValuationWalkthrough";

export default function ValuationIntro() {
  const [, setLocation] = useLocation();

  return (
    <div className="min-h-screen bg-background">
      <Header />

      <main className="container mx-auto px-6 py-12">
        <div className="max-w-4xl mx-auto space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold">Valuation Module</h1>
              <p className="text-muted-foreground mt-1">
                Quick overview before starting the Valuation workflow.
              </p>
            </div>
            <Button variant="outline" onClick={() => setLocation("/")}>
              <Home className="w-4 h-4 mr-2" />
              Home
            </Button>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>What Valuation Module Does</CardTitle>
              <CardDescription>
                Analyze your live Azure resources and identify cost optimization opportunities.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <p>- Connect to your Azure subscription and verify credentials.</p>
              <p>- Scan all deployed resources to identify SKUs and tiers.</p>
              <p>- Calculate current costs using Azure Retail Pricing API.</p>
              <p>- Generate cost reduction recommendations based on resource analysis.</p>
              <p>- Export detailed report with potential savings.</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Quick Walkthrough</CardTitle>
              <CardDescription>
                Interactive walkthrough of the Valuation workflow. Click play or navigate through the slides.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ValuationWalkthrough />
            </CardContent>
          </Card>

          <div className="flex justify-end">
            <Button onClick={() => setLocation("/valuation/app")}>
              Proceed to Valuation
              <ArrowRight className="w-4 h-4 ml-2" />
            </Button>
          </div>
        </div>
      </main>
    </div>
  );
}
