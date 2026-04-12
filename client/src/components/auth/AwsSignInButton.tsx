import { useState, useEffect } from "react";
import { motion } from "framer-motion";

interface AwsSignInButtonProps {
  label?: string;
  className?: string;
  testId?: string;
}

/** AWS smile-arrow logo SVG (brand-compliant orange) */
function AwsLogo() {
  return (
    <svg width="20" height="20" viewBox="0 0 50 30" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* AWS text */}
      <text
        x="0" y="22"
        fontFamily="Amazon Ember, Arial, sans-serif"
        fontWeight="bold"
        fontSize="22"
        fill="#FF9900"
      >
        aws
      </text>
      {/* Smile arrow */}
      <path
        d="M7 26 Q25 34 43 26"
        stroke="#FF9900"
        strokeWidth="2.5"
        fill="none"
        strokeLinecap="round"
      />
      <polygon points="43,23 47,26 43,29" fill="#FF9900" />
    </svg>
  );
}

/**
 * "Sign in with AWS" button.
 *
 * Checks /api/auth/aws/status to confirm Cognito SSO is configured,
 * then redirects to /api/auth/aws to start the OAuth2 flow.
 * Hidden if the server reports SSO is not configured.
 */
export default function AwsSignInButton({
  label = "Sign in with AWS",
  className = "",
  testId = "btn-aws-sso",
}: AwsSignInButtonProps) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch("/api/auth/aws/status")
      .then((r) => r.json())
      .then((data) => setConfigured(data.configured === true))
      .catch(() => setConfigured(false));
  }, []);

  const isConfigured = configured === true;
  const isChecking   = configured === null;

  const handleClick = () => {
    if (!isConfigured) return;
    setLoading(true);
    window.location.href = "/api/auth/aws";
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
            ? "bg-[#232f3e] hover:bg-[#1a2332] text-white hover:shadow-md cursor-pointer"
            : "bg-white/10 text-white/30 cursor-not-allowed"}
          disabled:opacity-50 disabled:cursor-not-allowed
          ${className}
        `}
        aria-label="Sign in with AWS account"
        title={!isConfigured && !isChecking ? "AWS SSO is not configured on this server" : undefined}
      >
        {loading ? (
          <div className="w-5 h-5 border-2 border-orange-300 border-t-orange-500 rounded-full animate-spin" />
        ) : (
          <AwsLogo />
        )}
        <span>{loading ? "Redirecting to AWS…" : label}</span>
      </motion.button>
      {!isConfigured && !isChecking && (
        <p className="text-center text-white/30 text-xs">
          AWS SSO not configured — contact your administrator
        </p>
      )}
    </div>
  );
}
