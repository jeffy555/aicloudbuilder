import type { Express } from "express";
import { randomBytes } from "crypto";
import { storage } from "../storage";
import { generateToken } from "../middleware/auth";
import { db } from "../db";
import { users } from "@shared/schema";
import { eq, or } from "drizzle-orm";

// ─── Microsoft OAuth2 configuration ──────────────────────────────────────────
// Register an App in Azure Portal → App registrations → New registration
// Set redirect URI to: https://<your-domain>/api/auth/microsoft/callback
// Grant API permissions: openid, profile, email, User.Read
//
// Required env vars:
//   MICROSOFT_CLIENT_ID      — Application (client) ID from App registration
//   MICROSOFT_CLIENT_SECRET  — Client secret from Certificates & secrets
//   MICROSOFT_REDIRECT_URI   — Must match exactly what's registered in Azure Portal
//   MICROSOFT_TENANT_ID      — 'common' for multi-tenant (any MS account), or your tenant ID

const MICROSOFT_AUTH_URL = "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize";
const MICROSOFT_TOKEN_URL = "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token";
const MICROSOFT_GRAPH_ME   = "https://graph.microsoft.com/v1.0/me";

// In-memory CSRF state store — keyed by state value, auto-expires after 10 minutes
const oauthStateStore = new Map<string, number>();
const STATE_TTL_MS = 10 * 60 * 1000;

function storeState(state: string) {
  oauthStateStore.set(state, Date.now() + STATE_TTL_MS);
}

function validateAndConsumeState(state: string): boolean {
  const expiry = oauthStateStore.get(state);
  if (!expiry) return false;
  oauthStateStore.delete(state);
  return Date.now() < expiry;
}

function getConfig() {
  const clientId     = process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;
  const redirectUri  = process.env.MICROSOFT_REDIRECT_URI;
  const tenant       = process.env.MICROSOFT_TENANT_ID || "common";

  return { clientId, clientSecret, redirectUri, tenant };
}

function isMicrosoftConfigured(): boolean {
  const { clientId, clientSecret, redirectUri } = getConfig();
  return !!(clientId && clientSecret && redirectUri);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Derive a safe, unique username from a Microsoft display name or email */
async function deriveUsername(displayName: string, email: string): Promise<string> {
  // Start from the display name slug or email prefix
  const base = displayName
    ? displayName.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 20)
    : email.split("@")[0].toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 20);

  const candidate = base || "user";

  // Check if the base username is available
  const existing = await db.select().from(users).where(eq(users.username, candidate)).limit(1);
  if (existing.length === 0) return candidate;

  // Append a short random suffix to resolve conflicts
  const suffix = randomBytes(3).toString("hex"); // e.g. "a1b2c3"
  return `${candidate}_${suffix}`;
}

/** Exchange an auth code for access + id tokens */
async function exchangeCodeForToken(code: string, tenant: string, clientId: string, clientSecret: string, redirectUri: string) {
  const body = new URLSearchParams({
    client_id:     clientId,
    client_secret: clientSecret,
    code,
    redirect_uri:  redirectUri,
    grant_type:    "authorization_code",
    scope:         "openid profile email User.Read",
  });

  const response = await fetch(
    MICROSOFT_TOKEN_URL.replace("{tenant}", tenant),
    {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:    body.toString(),
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Microsoft token exchange failed: ${text}`);
  }

  return response.json() as Promise<{
    access_token:  string;
    id_token?:     string;
    token_type:    string;
    expires_in:    number;
    error?:        string;
    error_description?: string;
  }>;
}

/** Fetch the signed-in user's profile from Microsoft Graph */
async function fetchMicrosoftProfile(accessToken: string) {
  const response = await fetch(MICROSOFT_GRAPH_ME, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error("Failed to fetch Microsoft user profile");
  }

  return response.json() as Promise<{
    id:          string;   // Microsoft OID — stable unique identifier
    displayName: string;
    mail:        string | null;
    userPrincipalName: string;
  }>;
}

// ─── Route registration ───────────────────────────────────────────────────────

export function registerMicrosoftAuthRoutes(app: Express) {

  /**
   * GET /api/auth/microsoft
   * Initiate the Microsoft OAuth2 Authorization Code flow.
   * Redirects the browser to the Microsoft login page.
   */
  app.get("/api/auth/microsoft", (req, res) => {
    if (!isMicrosoftConfigured()) {
      return res.status(503).json({
        error: "Microsoft SSO is not configured. Set MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, and MICROSOFT_REDIRECT_URI.",
      });
    }

    const { clientId, redirectUri, tenant } = getConfig();

    // Generate a random state value to prevent CSRF
    const state = randomBytes(32).toString("hex");
    storeState(state);

    const params = new URLSearchParams({
      client_id:     clientId!,
      response_type: "code",
      redirect_uri:  redirectUri!,
      response_mode: "query",
      scope:         "openid profile email User.Read",
      state,
      // prompt=select_account lets users switch accounts — good for multi-tenant SaaS
      prompt:        "select_account",
    });

    const authUrl = MICROSOFT_AUTH_URL.replace("{tenant}", tenant) + "?" + params.toString();
    res.redirect(authUrl);
  });

  /**
   * GET /api/auth/microsoft/callback
   * Microsoft redirects here after the user authenticates.
   * Exchanges the code for tokens, fetches the user profile,
   * creates or finds the user, issues a JWT, and redirects to the frontend.
   */
  app.get("/api/auth/microsoft/callback", async (req, res) => {
    try {
      const { code, state, error, error_description } = req.query as Record<string, string>;

      // ── Handle Microsoft-side errors (user cancelled, etc.) ──────────────
      if (error) {
        console.warn(`[MSAuth] Microsoft returned error: ${error} — ${error_description}`);
        const msg = encodeURIComponent(error_description || "Microsoft sign-in failed");
        return res.redirect(`/login?error=${msg}`);
      }

      // ── Validate state (CSRF protection) ─────────────────────────────────
      if (!state || !validateAndConsumeState(state)) {
        console.warn("[MSAuth] State mismatch — possible CSRF attempt");
        return res.redirect("/login?error=Invalid+state+parameter");
      }

      if (!code) {
        return res.redirect("/login?error=No+authorization+code+received");
      }

      if (!isMicrosoftConfigured()) {
        return res.redirect("/login?error=Microsoft+SSO+not+configured");
      }

      const { clientId, clientSecret, redirectUri, tenant } = getConfig();

      // ── Exchange auth code for access token ───────────────────────────────
      const tokenResponse = await exchangeCodeForToken(
        code, tenant, clientId!, clientSecret!, redirectUri!
      );

      if (tokenResponse.error) {
        console.error("[MSAuth] Token error:", tokenResponse.error_description);
        return res.redirect("/login?error=" + encodeURIComponent(tokenResponse.error_description || "Token exchange failed"));
      }

      // ── Fetch user profile from Microsoft Graph ───────────────────────────
      const profile = await fetchMicrosoftProfile(tokenResponse.access_token);

      // Prefer mail; fall back to userPrincipalName (works for work/school accounts)
      const email = profile.mail || profile.userPrincipalName;
      const microsoftId = profile.id;

      if (!email) {
        return res.redirect("/login?error=Could+not+retrieve+email+from+Microsoft+account");
      }

      // ── Find or create the user ───────────────────────────────────────────
      let user = await storage.getUserByMicrosoftId(microsoftId);

      if (!user) {
        // Check if a local account already exists with this email — link them
        const existingByEmail = await db
          .select()
          .from(users)
          .where(eq(users.email, email))
          .limit(1);

        if (existingByEmail.length > 0) {
          // Link the existing local account to this Microsoft identity
          user = await storage.updateUserMicrosoftId(existingByEmail[0].id, microsoftId);
          console.log(`[MSAuth] Linked Microsoft identity to existing account: ${email}`);
        } else {
          // New user — create account
          const username = await deriveUsername(profile.displayName || "", email);
          user = await storage.createUser({
            username,
            email,
            password: null,        // SSO users have no local password
            microsoftId,
            authProvider: "microsoft",
          } as any);
          console.log(`[MSAuth] Created new user via Microsoft SSO: ${email}`);
        }
      }

      // ── Issue our own JWT ─────────────────────────────────────────────────
      const token = generateToken(user.id, user.username, user.email);

      // Redirect to the frontend callback handler with token in query param
      // The frontend reads this, stores it, and redirects to the dashboard
      res.redirect(`/auth/callback?token=${encodeURIComponent(token)}`);

    } catch (err: any) {
      console.error("[MSAuth] Callback error:", err);
      res.redirect("/login?error=" + encodeURIComponent("Sign-in failed. Please try again."));
    }
  });

  /**
   * GET /api/auth/microsoft/status
   * Returns whether Microsoft SSO is configured — used by the frontend
   * to decide whether to show the "Sign in with Microsoft" button.
   */
  app.get("/api/auth/microsoft/status", (_req, res) => {
    res.json({ configured: isMicrosoftConfigured() });
  });
}
