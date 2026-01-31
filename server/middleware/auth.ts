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

// JWT secret from environment variable
const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key-change-in-production";

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
      } catch (error) {
        // Token invalid, but continue without auth
      }
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

