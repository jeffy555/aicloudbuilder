import { Switch, Route, useLocation } from "wouter";
import { useEffect } from "react";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAuth } from "@/hooks/auth/useAuth";
import PageTransition from "@/components/PageTransition";
import Landing from "@/pages/Landing";
import Signup from "@/pages/Signup";
import Login from "@/pages/Login";
import Settings from "@/pages/Settings";
import ScoreMe from "@/pages/ScoreMe";
import ScoreMeIntro from "@/pages/ScoreMeIntro";
import TerraformWorkflow from "@/pages/TerraformWorkflow";
import TerraformIntro from "@/pages/TerraformIntro";
import AutomationWorkflow from "@/pages/AutomationWorkflow";
import AutomationIntro from "@/pages/AutomationIntro";
import ArchMeWorkflow from "@/pages/ArchMeWorkflow";
import ArchMeIntro from "@/pages/ArchMeIntro";
import KubernetesWorkflow from "@/pages/KubernetesWorkflow";
import KubernetesIntro from "@/pages/KubernetesIntro";
import DockerWorkflow from "@/pages/DockerWorkflow";
import DockerIntro from "@/pages/DockerIntro";
import History from "@/pages/History";
import NotFound from "@/pages/not-found";

/**
 * ProtectedRoute component
 * Wraps routes that require authentication
 */
function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      setLocation('/login');
    }
  }, [isLoading, isAuthenticated, setLocation]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-4 border-primary/20 border-t-primary rounded-full animate-spin" />
          <p className="text-muted-foreground font-medium">Verifying session...</p>
        </div>
      </div>
    );
  }

  return isAuthenticated ? <>{children}</> : null;
}

function Router() {
  return (
    <Switch>
      <Route path="/">
        <ProtectedRoute>
          <PageTransition>
            <Landing />
          </PageTransition>
        </ProtectedRoute>
      </Route>
      <Route path="/signup">
        <PageTransition>
          <Signup />
        </PageTransition>
      </Route>
      <Route path="/login">
        <PageTransition>
          <Login />
        </PageTransition>
      </Route>
      <Route path="/settings">
        <ProtectedRoute>
          <PageTransition>
            <Settings />
          </PageTransition>
        </ProtectedRoute>
      </Route>
      <Route path="/terraform">
        <ProtectedRoute>
          <PageTransition>
            <TerraformIntro />
          </PageTransition>
        </ProtectedRoute>
      </Route>
      <Route path="/terraform/app">
        <ProtectedRoute>
          <PageTransition>
            <TerraformWorkflow />
          </PageTransition>
        </ProtectedRoute>
      </Route>
      <Route path="/automation">
        <ProtectedRoute>
          <PageTransition>
            <AutomationIntro />
          </PageTransition>
        </ProtectedRoute>
      </Route>
      <Route path="/automation/app">
        <ProtectedRoute>
          <PageTransition>
            <AutomationWorkflow />
          </PageTransition>
        </ProtectedRoute>
      </Route>
      <Route path="/scoreme">
        <ProtectedRoute>
          <PageTransition>
            <ScoreMeIntro />
          </PageTransition>
        </ProtectedRoute>
      </Route>
      <Route path="/scoreme/app">
        <ProtectedRoute>
          <PageTransition>
            <ScoreMe />
          </PageTransition>
        </ProtectedRoute>
      </Route>
      <Route path="/archme">
        <ProtectedRoute>
          <PageTransition>
            <ArchMeIntro />
          </PageTransition>
        </ProtectedRoute>
      </Route>
      <Route path="/archme/app">
        <ProtectedRoute>
          <PageTransition>
            <ArchMeWorkflow />
          </PageTransition>
        </ProtectedRoute>
      </Route>
      <Route path="/kubernetes">
        <ProtectedRoute>
          <PageTransition>
            <KubernetesIntro />
          </PageTransition>
        </ProtectedRoute>
      </Route>
      <Route path="/kubernetes/app">
        <ProtectedRoute>
          <PageTransition>
            <KubernetesWorkflow />
          </PageTransition>
        </ProtectedRoute>
      </Route>
      <Route path="/docker">
        <ProtectedRoute>
          <PageTransition>
            <DockerIntro />
          </PageTransition>
        </ProtectedRoute>
      </Route>
      <Route path="/docker/app">
        <ProtectedRoute>
          <PageTransition>
            <DockerWorkflow />
          </PageTransition>
        </ProtectedRoute>
      </Route>
      <Route path="/history">
        <ProtectedRoute>
          <PageTransition>
            <History />
          </PageTransition>
        </ProtectedRoute>
      </Route>
      <Route>
        <PageTransition>
          <NotFound />
        </PageTransition>
      </Route>
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Router />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
