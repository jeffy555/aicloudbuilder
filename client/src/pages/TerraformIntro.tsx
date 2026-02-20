import { useLocation } from "wouter";
import Header from "@/components/Header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowRight, Home } from "lucide-react";
import TerraformWalkthrough from "@/components/TerraformWalkthrough";

export default function TerraformIntro() {
  const [, setLocation] = useLocation();

  return (
    <div className="min-h-screen bg-background">
      <Header />

      <main className="container mx-auto px-6 py-12">
        <div className="max-w-4xl mx-auto space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold">Terraform Module</h1>
              <p className="text-muted-foreground mt-1">
                Quick overview before starting the Terraform workflow.
              </p>
            </div>
            <Button variant="outline" onClick={() => setLocation("/")}>
              <Home className="w-4 h-4 mr-2" />
              Home
            </Button>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>What Terraform Module Does</CardTitle>
              <CardDescription>
                Terraform module helps generate and refine infrastructure as code for cloud
                environments using guided AI-assisted input.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <p>- Select provider and repository context.</p>
              <p>- Generate Terraform resources from your intent.</p>
              <p>- Review, validate, fix findings, and proceed to commit.</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Walkthrough</CardTitle>
              <CardDescription>
                See how the Terraform workflow works step by step. Auto-plays every 5 seconds or use the controls to navigate.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <TerraformWalkthrough />
            </CardContent>
          </Card>

          <div className="flex justify-end">
            <Button onClick={() => setLocation("/terraform/app")}>
              Proceed to Terraform
              <ArrowRight className="w-4 h-4 ml-2" />
            </Button>
          </div>
        </div>
      </main>
    </div>
  );
}


