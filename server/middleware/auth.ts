import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

// Extend Express Request to include userId
export interface AuthenticatedRequest extends Request {
  userId?: string;
  user?: {
    id: string;
    username: string;
    email: string;
  };
}

const FALLBACK_JWT_SECRET = "your-secret-key-change-in-production";
const configuredJwtSecret = process.env.JWT_SECRET?.trim();
const isProduction = process.env.NODE_ENV === "production";

if (!configuredJwtSecret && isProduction) {
  throw new Error("JWT_SECRET is required in production.");
}

if (!configuredJwtSecret && !isProduction) {
  console.warn("⚠️  JWT_SECRET is not set. Using development fallback secret.");
}

// JWT secret from environment variable (fallback allowed only in development)
const JWT_SECRET = configuredJwtSecret || FALLBACK_JWT_SECRET;

/**
 * Middleware to require authentication
 * Verifies JWT token from Authorization header or session
 */
export function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  try {
    // Check for token in Authorization header
    const authHeader = req.headers.authorization;
    let token: string | undefined;

    if (authHeader && authHeader.startsWith("Bearer ")) {
      token = authHeader.substring(7);
    } else if (req.session && (req.session as any).token) {
      // Fallback to session token
      token = (req.session as any).token;
    }

    if (!token) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    // Verify token
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: string; username: string; email: string };
    
    // Attach user info to request
    req.userId = decoded.userId;
    req.user = {
      id: decoded.userId,
      username: decoded.username,
      email: decoded.email,
    };

    next();
  } catch (error: any) {
    if (error.name === "JsonWebTokenError" || error.name === "TokenExpiredError") {
      res.status(401).json({ error: "Invalid or expired token" });
      return;
    }
    console.error("Auth middleware error:", error);
    res.status(500).json({ error: "Authentication error" });
  }
}

/**
 * Optional authentication middleware
 * Attaches user info if token is present, but doesn't require it
 */
export function optionalAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  try {
    const authHeader = req.headers.authorization;
    let token: string | undefined;

    if (authHeader && authHeader.startsWith("Bearer ")) {
      token = authHeader.substring(7);
    } else if (req.session && (req.session as any).token) {
      token = (req.session as any).token;
    }

    if (token) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET) as { userId: string; username: string; email: string };
        req.userId = decoded.userId;
        req.user = {
          id: decoded.userId,
          username: decoded.username,
          email: decoded.email,
        };
      } catch (error: any) {
        // Log why the token failed — visible in Azure Container App logs
        console.warn(`⚠️  [optionalAuth] JWT verification failed: ${error?.name} — ${error?.message}. Token preview: ${token?.substring(0, 20)}...`);
      }
    } else {
      console.debug(`[optionalAuth] No Authorization header or session token on ${req.method} ${req.path}`);
    }

    next();
  } catch (error) {
    // Continue without auth
    next();
  }
}

/**
 * Generate JWT token for user
 */
export function generateToken(userId: string, username: string, email: string): string {
  return jwt.sign(
    { userId, username, email },
    JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
  );
}

