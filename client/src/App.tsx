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
import TerraformWorkflow from "@/pages/TerraformWorkflow";
import AutomationWorkflow from "@/pages/AutomationWorkflow";
import ArchMeWorkflow from "@/pages/ArchMeWorkflow";
import KubernetesWorkflow from "@/pages/KubernetesWorkflow";
import DockerWorkflow from "@/pages/DockerWorkflow";
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
            <TerraformWorkflow />
          </PageTransition>
        </ProtectedRoute>
      </Route>
      <Route path="/automation">
        <ProtectedRoute>
          <PageTransition>
            <AutomationWorkflow />
          </PageTransition>
        </ProtectedRoute>
      </Route>
      <Route path="/scoreme">
        <ProtectedRoute>
          <PageTransition>
            <ScoreMe />
          </PageTransition>
        </ProtectedRoute>
      </Route>
      <Route path="/archme">
        <ProtectedRoute>
          <PageTransition>
            <ArchMeWorkflow />
          </PageTransition>
        </ProtectedRoute>
      </Route>
      <Route path="/kubernetes">
        <ProtectedRoute>
          <PageTransition>
            <KubernetesWorkflow />
          </PageTransition>
        </ProtectedRoute>
      </Route>
      <Route path="/docker">
        <ProtectedRoute>
          <PageTransition>
            <DockerWorkflow />
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
