import type { Express } from "express";
import bcrypt from "bcrypt";
import { storage } from "../storage";
import { requireAuth, optionalAuth, generateToken, type AuthenticatedRequest } from "../middleware/auth";
import { insertUserSchema } from "@shared/schema";
import { eq, or } from "drizzle-orm";
import { db } from "../db";
import { users } from "@shared/schema";

const SALT_ROUNDS = 10;

export function registerAuthRoutes(app: Express) {
  /**
   * POST /api/auth/signup
   * Create a new user account
   */
  app.post("/api/auth/signup", async (req, res) => {
    try {
      // Validate request body
      const validationResult = insertUserSchema.safeParse(req.body);
      if (!validationResult.success) {
        return res.status(400).json({
          error: "Validation failed",
          errors: validationResult.error.flatten().fieldErrors,
        });
      }

      const { username, email, password } = validationResult.data;

      // Additional validation
      if (username.length < 3 || username.length > 30) {
        return res.status(400).json({
          error: "Validation failed",
          errors: { username: "Username must be between 3 and 30 characters" },
        });
      }

      if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
        return res.status(400).json({
          error: "Validation failed",
          errors: { username: "Username can only contain letters, numbers, underscores, and hyphens" },
        });
      }

      // Email validation
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return res.status(400).json({
          error: "Validation failed",
          errors: { email: "Please enter a valid email address" },
        });
      }

      // Password validation
      if (password.length < 8) {
        return res.status(400).json({
          error: "Validation failed",
          errors: { password: "Password must be at least 8 characters long" },
        });
      }

      const hasUpperCase = /[A-Z]/.test(password);
      const hasLowerCase = /[a-z]/.test(password);
      const hasNumber = /[0-9]/.test(password);

      if (!hasUpperCase || !hasLowerCase || !hasNumber) {
        return res.status(400).json({
          error: "Validation failed",
          errors: {
            password: "Password must contain at least one uppercase letter, one lowercase letter, and one number",
          },
        });
      }

      // Check if username or email already exists
      const existingUser = await db
        .select()
        .from(users)
        .where(or(eq(users.username, username), eq(users.email, email)))
        .limit(1);

      if (existingUser.length > 0) {
        const errors: Record<string, string> = {};
        if (existingUser[0].username === username) {
          errors.username = "Username already exists";
        }
        if (existingUser[0].email === email) {
          errors.email = "Email already exists";
        }
        return res.status(400).json({
          error: "User already exists",
          errors,
        });
      }

      // Hash password
      const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

      // Create user
      const newUser = await storage.createUser({
        username,
        email,
        password: hashedPassword,
      });

      // Generate token
      const token = generateToken(newUser.id, newUser.username, newUser.email);

      // Store token in session (optional)
      if (req.session) {
        (req.session as any).token = token;
        (req.session as any).userId = newUser.id;
      }

      // Return user (without password)
      const { password: _, ...userWithoutPassword } = newUser;

      res.status(201).json({
        message: "User created successfully",
        user: userWithoutPassword,
        token,
      });
    } catch (error: any) {
      console.error("Signup error:", error);
      res.status(500).json({ error: "Failed to create user account" });
    }
  });

  /**
   * POST /api/auth/login
   * Authenticate user and create session
   */
  app.post("/api/auth/login", async (req, res) => {
    try {
      const { usernameOrEmail, password, rememberMe } = req.body;

      if (!usernameOrEmail || !password) {
        return res.status(400).json({
          error: "Validation failed",
          errors: {
            usernameOrEmail: "Username or email is required",
            password: "Password is required",
          },
        });
      }

      // Find user by username or email
      const user = await db
        .select()
        .from(users)
        .where(or(eq(users.username, usernameOrEmail), eq(users.email, usernameOrEmail)))
        .limit(1);

      if (user.length === 0) {
        return res.status(401).json({
          error: "Invalid credentials",
        });
      }

      // Verify password
      const isValidPassword = await bcrypt.compare(password, user[0].password);
      if (!isValidPassword) {
        return res.status(401).json({
          error: "Invalid credentials",
        });
      }

      // Generate token
      const token = generateToken(user[0].id, user[0].username, user[0].email);

      // Store token in session
      if (req.session) {
        (req.session as any).token = token;
        (req.session as any).userId = user[0].id;
        
        // Set session expiration based on rememberMe
        if (rememberMe) {
          req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000; // 30 days
        } else {
          req.session.cookie.maxAge = 24 * 60 * 60 * 1000; // 1 day
        }
      }

      // Return user (without password)
      const { password: _, ...userWithoutPassword } = user[0];

      res.json({
        message: "Login successful",
        user: userWithoutPassword,
        token,
      });
    } catch (error: any) {
      console.error("Login error:", error);
      res.status(500).json({ error: "Failed to authenticate user" });
    }
  });

  /**
   * POST /api/auth/logout
   * Logout user and destroy session
   */
  app.post("/api/auth/logout", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      if (req.session) {
        req.session.destroy((err) => {
          if (err) {
            console.error("Session destroy error:", err);
            return res.status(500).json({ error: "Failed to logout" });
          }
          res.json({ message: "Logout successful" });
        });
      } else {
        res.json({ message: "Logout successful" });
      }
    } catch (error: any) {
      console.error("Logout error:", error);
      res.status(500).json({ error: "Failed to logout" });
    }
  });

  /**
   * GET /api/auth/me
   * Get current authenticated user
   */
  app.get("/api/auth/me", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const user = await storage.getUserById(req.userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      // Return user (without password)
      const { password: _, ...userWithoutPassword } = user;

      res.json({
        user: userWithoutPassword,
      });
    } catch (error: any) {
      console.error("Get current user error:", error);
      res.status(500).json({ error: "Failed to get user information" });
    }
  });
}

