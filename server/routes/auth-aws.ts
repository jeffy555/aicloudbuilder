import type { Express } from "express";
import { randomBytes } from "crypto";
import { storage } from "../storage";
import { generateToken } from "../middleware/auth";
import { db } from "../db";
import { users } from "@shared/schema";
import { eq } from "drizzle-orm";

// ─── AWS Cognito OAuth2 / OIDC configuration ──────────────────────────────────
//
// Setup in AWS Console:
//  1. Cognito → Create user pool
//  2. App client: Confidential client, callback URL: <your-domain>/api/auth/aws/callback
//  3. Cognito domain: <prefix>.auth.<region>.amazoncognito.com
//  4. Scopes: openid, email, profile
//
// Required env vars:
//   AWS_COGNITO_CLIENT_ID      — App client ID from Cognito
//   AWS_COGNITO_CLIENT_SECRET  — App client secret
//   AWS_COGNITO_DOMAIN         — Full hosted UI domain (no trailing slash)
//                                e.g. aicloudbuilder-auth.auth.us-east-1.amazoncognito.com
//   AWS_COGNITO_REDIRECT_URI   — Must match exactly what's registered in Cognito
//   AWS_COGNITO_REGION         — AWS region where the user pool lives (e.g. us-east-1)

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
  const clientId    = process.env.AWS_COGNITO_CLIENT_ID;
  const clientSecret = process.env.AWS_COGNITO_CLIENT_SECRET;
  const domain      = process.env.AWS_COGNITO_DOMAIN;
  const redirectUri = process.env.AWS_COGNITO_REDIRECT_URI;
  const region      = process.env.AWS_COGNITO_REGION || "us-east-1";
  return { clientId, clientSecret, domain, redirectUri, region };
}

function isAwsConfigured(): boolean {
  const { clientId, clientSecret, domain, redirectUri } = getConfig();
  return !!(clientId && clientSecret && domain && redirectUri);
}

/** Derive a safe, unique username from a display name or email */
async function deriveUsername(displayName: string, email: string): Promise<string> {
  const base = displayName
    ? displayName.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 20)
    : email.split("@")[0].toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 20);

  const slug = base || "user";

  // Check if the base slug is taken; if so, append a random suffix
  const existing = await db
    .select()
    .from(users)
    .where(eq(users.username, slug))
    .limit(1);

  if (existing.length === 0) return slug;

  // Append 4 random hex chars
  return `${slug}_${randomBytes(2).toString("hex")}`;
}

/** Exchange the authorization code for Cognito tokens */
async function exchangeCodeForToken(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
  domain: string
): Promise<any> {
  const tokenUrl = `https://${domain}/oauth2/token`;

  const body = new URLSearchParams({
    grant_type:   "authorization_code",
    client_id:    clientId,
    code,
    redirect_uri: redirectUri,
  });

  // Cognito requires HTTP Basic auth when a client secret is present
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const resp = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type":  "application/x-www-form-urlencoded",
      "Authorization": `Basic ${credentials}`,
    },
    body: body.toString(),
  });

  return resp.json();
}

/** Fetch user profile from Cognito /oauth2/userInfo */
async function fetchCognitoProfile(accessToken: string, domain: string): Promise<any> {
  const resp = await fetch(`https://${domain}/oauth2/userInfo`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return resp.json();
}

// ─── Route registration ───────────────────────────────────────────────────────

export function registerAwsAuthRoutes(app: Express) {
  /**
   * GET /api/auth/aws
   * Initiate the AWS Cognito OAuth2 Authorization Code flow.
   * Redirects the browser to the Cognito hosted UI login page.
   */
  app.get("/api/auth/aws", (req, res) => {
    if (!isAwsConfigured()) {
      return res.status(503).json({
        error: "AWS SSO is not configured. Set AWS_COGNITO_CLIENT_ID, AWS_COGNITO_CLIENT_SECRET, AWS_COGNITO_DOMAIN, and AWS_COGNITO_REDIRECT_URI.",
      });
    }

    const { clientId, domain, redirectUri } = getConfig();

    const state = randomBytes(32).toString("hex");
    storeState(state);

    const params = new URLSearchParams({
      response_type: "code",
      client_id:     clientId!,
      redirect_uri:  redirectUri!,
      scope:         "openid email profile",
      state,
    });

    res.redirect(`https://${domain}/oauth2/authorize?${params.toString()}`);
  });

  /**
   * GET /api/auth/aws/callback
   * Cognito redirects here after the user authenticates.
   * Exchanges the code for tokens, fetches the user profile,
   * creates or finds the user, issues a JWT, and redirects to the frontend.
   */
  app.get("/api/auth/aws/callback", async (req, res) => {
    try {
      const { code, state, error, error_description } = req.query as Record<string, string>;

      // ── Handle Cognito-side errors ────────────────────────────────────────
      if (error) {
        console.warn(`[AWSAuth] Cognito returned error: ${error} — ${error_description}`);
        const msg = encodeURIComponent(error_description || "AWS sign-in failed");
        return res.redirect(`/login?error=${msg}`);
      }

      // ── Validate CSRF state ───────────────────────────────────────────────
      if (!state || !validateAndConsumeState(state)) {
        console.warn("[AWSAuth] State mismatch — possible CSRF attempt");
        return res.redirect("/login?error=Invalid+state+parameter");
      }

      if (!code) {
        return res.redirect("/login?error=No+authorization+code+received");
      }

      if (!isAwsConfigured()) {
        return res.redirect("/login?error=AWS+SSO+not+configured");
      }

      const { clientId, clientSecret, redirectUri, domain } = getConfig();

      // ── Exchange auth code for tokens ─────────────────────────────────────
      const tokenResponse = await exchangeCodeForToken(
        code, clientId!, clientSecret!, redirectUri!, domain!
      );

      if (tokenResponse.error) {
        console.error("[AWSAuth] Token error:", tokenResponse.error_description);
        return res.redirect("/login?error=" + encodeURIComponent(tokenResponse.error_description || "Token exchange failed"));
      }

      // ── Fetch user profile from Cognito userInfo endpoint ─────────────────
      const profile = await fetchCognitoProfile(tokenResponse.access_token, domain!);

      const email   = profile.email;
      const awsSub  = profile.sub; // Cognito unique user ID (stable across logins)
      const name    = profile.name || profile["cognito:username"] || "";

      if (!email) {
        return res.redirect("/login?error=Could+not+retrieve+email+from+AWS+account");
      }

      // ── Find or create the user ───────────────────────────────────────────
      let user = await storage.getUserByAwsSub(awsSub).catch(() => null);

      if (!user) {
        // Check if a local account already exists with this email — link it
        const existingByEmail = await db
          .select()
          .from(users)
          .where(eq(users.email, email))
          .limit(1);

        if (existingByEmail.length > 0) {
          user = await storage.updateUserAwsSub(existingByEmail[0].id, awsSub);
          console.log(`[AWSAuth] Linked AWS Cognito identity to existing account: ${email}`);
        } else {
          // New user — create account
          const username = await deriveUsername(name, email);
          user = await storage.createUser({
            username,
            email,
            password:     null,     // SSO users have no local password
            awsSub,
            authProvider: "aws",
          } as any);
          console.log(`[AWSAuth] Created new user via AWS SSO: ${email}`);
        }
      }

      // ── Issue our own JWT ─────────────────────────────────────────────────
      const token = generateToken(user.id, user.username, user.email);

      res.redirect(`/auth/callback?token=${encodeURIComponent(token)}`);

    } catch (err: any) {
      console.error("[AWSAuth] Callback error:", err);
      res.redirect("/login?error=" + encodeURIComponent("AWS sign-in failed. Please try again."));
    }
  });

  /**
   * GET /api/auth/aws/status
   * Returns whether AWS SSO is configured — used by the frontend
   * to decide whether to show the "Sign in with AWS" button.
   */
  app.get("/api/auth/aws/status", (_req, res) => {
    res.json({ configured: isAwsConfigured() });
  });
}
