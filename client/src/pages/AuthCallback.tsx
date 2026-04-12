import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";

/**
 * AuthCallback — handles the redirect from /api/auth/microsoft/callback
 *
 * The backend redirects here as:
 *   /auth/callback?token=<jwt>          — success
 *   /login?error=<message>              — failure (backend handles directly)
 *
 * On success:
 *  - Stores the JWT in localStorage (treated as "remember me" for SSO)
 *  - Shows a welcome toast
 *  - Redirects to the home dashboard
 */
export default function AuthCallback() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [status, setStatus] = useState<"processing" | "error">("processing");
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("token");
    const error = params.get("error");

    if (error) {
      setStatus("error");
      setErrorMessage(decodeURIComponent(error));
      toast({
        title: "Sign-in failed",
        description: decodeURIComponent(error),
        variant: "destructive",
      });
      // Redirect back to login after a moment
      setTimeout(() => setLocation("/login"), 3000);
      return;
    }

    if (!token) {
      setStatus("error");
      setErrorMessage("No token received from authentication provider.");
      setTimeout(() => setLocation("/login"), 3000);
      return;
    }

    // Store token — SSO sessions default to "remember me" (localStorage); clear session tab token
    sessionStorage.removeItem("token");
    localStorage.setItem("token", token);

    // Clear stale cache from any previous user's session
    queryClient.clear();

    toast({
      title: "Signed in with Microsoft",
      description: "Welcome! Redirecting to your dashboard…",
      variant: "default",
    });

    // Small delay so the toast is visible before redirect
    setTimeout(() => setLocation("/"), 800);
  }, []);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background gap-6">
      {status === "processing" ? (
        <>
          <div className="w-14 h-14 border-4 border-primary/20 border-t-primary rounded-full animate-spin" />
          <p className="text-muted-foreground font-medium text-lg">Completing sign-in…</p>
        </>
      ) : (
        <>
          <div className="text-4xl">⚠️</div>
          <p className="text-destructive font-medium text-lg">{errorMessage}</p>
          <p className="text-muted-foreground text-sm">Redirecting to login…</p>
        </>
      )}
    </div>
  );
}
