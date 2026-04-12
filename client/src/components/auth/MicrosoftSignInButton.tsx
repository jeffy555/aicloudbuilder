import { useState, useEffect } from "react";
import { motion } from "framer-motion";

interface MicrosoftSignInButtonProps {
  label?: string;
  className?: string;
  testId?: string;
}

/** Official Microsoft "M" logo SVG (brand-compliant colors) */
function MicrosoftLogo() {
  return (
    <svg width="20" height="20" viewBox="0 0 21 21" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="1"  y="1"  width="9" height="9" fill="#F25022" />
      <rect x="11" y="1"  width="9" height="9" fill="#7FBA00" />
      <rect x="1"  y="11" width="9" height="9" fill="#00A4EF" />
      <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
    </svg>
  );
}

/**
 * "Sign in with Microsoft" button.
 *
 * Checks /api/auth/microsoft/status to confirm SSO is configured,
 * then redirects to /api/auth/microsoft to start the OAuth2 flow.
 * Hidden if the server reports SSO is not configured.
 */
export default function MicrosoftSignInButton({
  label = "Sign in with Microsoft",
  className = "",
  testId = "btn-microsoft-sso",
}: MicrosoftSignInButtonProps) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch("/api/auth/microsoft/status")
      .then((r) => r.json())
      .then((data) => setConfigured(data.configured === true))
      .catch(() => setConfigured(false));
  }, []);

  const isConfigured = configured === true;
  const isChecking = configured === null;

  const handleClick = () => {
    if (!isConfigured) return;
    setLoading(true);
    // Full page redirect — the server handles the OAuth2 flow
    window.location.href = "/api/auth/microsoft";
  };

  return (
    <div className="w-full space-y-1">
      <motion.button
        onClick={handleClick}
        disabled={loading || !isConfigured || isChecking}
        whileHover={isConfigured ? { scale: 1.01 } : {}}
        whileTap={isConfigured ? { scale: 0.99 } : {}}
        data-testid={testId}
        className={`
          w-full flex items-center justify-center gap-3
          px-4 py-3 rounded-lg
          border border-white/20
          text-sm font-medium
          transition-all duration-200
          shadow-sm
          ${isConfigured
            ? "bg-white hover:bg-gray-50 text-gray-800 hover:shadow-md cursor-pointer"
            : "bg-white/10 text-white/30 cursor-not-allowed"}
          disabled:opacity-50 disabled:cursor-not-allowed
          ${className}
        `}
        aria-label="Sign in with Microsoft account"
        title={!isConfigured && !isChecking ? "Microsoft SSO is not configured on this server" : undefined}
      >
        {loading ? (
          <div className="w-5 h-5 border-2 border-gray-400 border-t-blue-600 rounded-full animate-spin" />
        ) : (
          <MicrosoftLogo />
        )}
        <span>{loading ? "Redirecting to Microsoft…" : label}</span>
      </motion.button>
      {!isConfigured && !isChecking && (
        <p className="text-center text-white/30 text-xs">
          Microsoft SSO not configured — contact your administrator
        </p>
      )}
    </div>
  );
}
