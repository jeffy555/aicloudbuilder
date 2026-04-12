import { z } from "zod";

const userWithoutPassword = z.object({
  id: z.string(),
  username: z.string(),
  email: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
}).openapi("UserPublic");

// POST /api/auth/signup
export const signupBody = z.object({
  username: z.string().min(3).max(30),
  email: z.string().email(),
  password: z.string().min(8),
}).openapi("SignupBody");

export const signupResponse = z.object({
  message: z.string(),
  user: userWithoutPassword,
  token: z.string(),
}).openapi("SignupResponse");

// POST /api/auth/login
export const loginBody = z.object({
  usernameOrEmail: z.string().trim().min(1, "Username or email is required"),
  password: z.string().min(1, "Password is required"),
  // Accept boolean, omit, null, or string forms from odd clients / proxies
  rememberMe: z
    .union([z.boolean(), z.literal("true"), z.literal("false")])
    .optional()
    .nullable()
    .transform((v) => v === true || v === "true"),
}).openapi("LoginBody");

export const loginResponse = z.object({
  message: z.string(),
  user: userWithoutPassword,
  token: z.string(),
}).openapi("LoginResponse");

// POST /api/auth/logout — no body
export const logoutResponse = z.object({
  message: z.string(),
}).openapi("LogoutResponse");

// GET /api/auth/me
export const meResponse = z.object({
  user: userWithoutPassword,
}).openapi("MeResponse");
