import 'dotenv/config';
import express, { type Request, Response, NextFunction } from "express";
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { registerRoutes } from "./routes";
import { setupVite, serveStatic, log } from "./vite";
import { remediationRAGService } from "./rag/remediation-rag";
import { logFeatureFlagStatus, featureFlagMiddleware } from "./middleware/feature-flags";

const app = express();

// ─── Security Headers (Helmet.js) ──────────────────────────────────────────
// Applied in all environments. Adds X-Frame-Options, X-Content-Type-Options,
// Referrer-Policy, HSTS (production), and more.
app.use(helmet({
  contentSecurityPolicy: process.env.NODE_ENV === 'production' ? {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],   // unsafe-inline needed by React runtime
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    }
  } : false,  // Disabled in dev to avoid breaking Vite HMR
  crossOriginEmbedderPolicy: false,  // Disabled — Mermaid loads web workers
}));

// ─── CORS Policy (production only) ─────────────────────────────────────────
// Allowlist the Container App domain and localhost for dev.
// CONTAINER_APP_ORIGIN env var must be set on the Container App (e.g. https://myapp.azurecontainerapps.io)
if (process.env.NODE_ENV === 'production') {
  const allowedOrigins = new Set<string>(
    [process.env.CONTAINER_APP_ORIGIN, 'http://localhost:9005']
      .filter(Boolean) as string[]
  );
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    }
    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }
    next();
  });
}

// ─── Rate Limiting (production only) ───────────────────────────────────────
// Protects against credential stuffing, brute force, and AI cost abuse.
// Localhost dev is unaffected (NODE_ENV !== 'production').
if (process.env.NODE_ENV === 'production') {
  // Auth endpoints: 10 attempts per 15 minutes per IP
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests — please try again later.' },
  });
  app.use('/api/auth', authLimiter);

  // AI generation endpoints: 20 calls per minute per IP
  // Covers generate-terraform, generate-dockerfile, generate-compose, generate-helm-chart, etc.
  const aiGenLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Generation rate limit exceeded — please wait a moment.' },
    skip: (req) => req.method !== 'POST',
  });
  app.use('/api/sessions', aiGenLimiter);
}

declare module 'http' {
  interface IncomingMessage {
    rawBody: unknown
  }
}
app.use(express.json({
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({ extended: false }));

// Phase 0: Feature flag middleware
app.use(featureFlagMiddleware);

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  // Phase 0: Log feature flag status
  logFeatureFlagStatus();

  // Run DB migrations on startup
  try {
    const { addMicrosoftAuth } = await import("./migrations/add-microsoft-auth");
    await addMicrosoftAuth();
  } catch (error: any) {
    console.error('⚠️  Migration add-microsoft-auth failed:', error.message);
  }

  try {
    const { addAwsAuthColumn } = await import("./migrations/add-aws-auth-column");
    await addAwsAuthColumn();
  } catch (error: any) {
    console.error('⚠️  Migration add-aws-auth-column failed:', error.message);
  }

  // Initialize RAG service on server startup
  try {
    await remediationRAGService.initialize();
  } catch (error: any) {
    console.error('⚠️  Failed to initialize RAG service:', error.message);
    console.error('   Fixes will still work but may be less accurate for unmapped checks');
  }

  const server = await registerRoutes(app);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    res.status(status).json({ message });
    throw err;
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (app.get("env") === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Default to 9005 if not specified.
  // this serves both the API and the client.
  const port = parseInt(process.env.PORT || '9005', 10);
  server.listen(port, "0.0.0.0", () => {
    log(`serving on port ${port}`);
  });
})();
