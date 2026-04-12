/**
 * Contract test: Auth endpoints
 * Validates signup, login, me, and logout responses match the OpenAPI contract.
 */
import { describe, it, expect } from "vitest";
import { getAgent, validateSchema } from "./helpers/contract-utils";
import { signupResponse, loginResponse, meResponse, logoutResponse } from "@shared/api-contracts/auth";
import { errorResponse } from "@shared/api-contracts/common";

describe("Auth Contract", () => {
  const testUser = {
    username: `sddtest_${Date.now()}`,
    email: `sddtest_${Date.now()}@test.com`,
    password: "TestPass123",
  };

  let authToken: string;

  it("POST /api/auth/signup returns valid response", async () => {
    const res = await getAgent()
      .post("/api/auth/signup")
      .send(testUser)
      .expect(201);

    const validation = validateSchema(signupResponse, res.body);
    expect(validation.success, `Schema mismatch: ${validation.issues.join(", ")}`).toBe(true);
    expect(res.body.token).toBeDefined();
    expect(res.body.user.username).toBe(testUser.username);
    authToken = res.body.token;
  });

  it("POST /api/auth/signup with invalid data returns error response", async () => {
    const res = await getAgent()
      .post("/api/auth/signup")
      .send({ username: "a", email: "bad", password: "short" })
      .expect(400);

    const validation = validateSchema(errorResponse, res.body);
    expect(validation.success, `Schema mismatch: ${validation.issues.join(", ")}`).toBe(true);
  });

  it("POST /api/auth/login returns valid response", async () => {
    const res = await getAgent()
      .post("/api/auth/login")
      .send({ usernameOrEmail: testUser.username, password: testUser.password })
      .expect(200);

    const validation = validateSchema(loginResponse, res.body);
    expect(validation.success, `Schema mismatch: ${validation.issues.join(", ")}`).toBe(true);
    expect(res.body.token).toBeDefined();
    authToken = res.body.token;
  });

  it("GET /api/auth/me returns valid response", async () => {
    const res = await getAgent()
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${authToken}`)
      .expect(200);

    const validation = validateSchema(meResponse, res.body);
    expect(validation.success, `Schema mismatch: ${validation.issues.join(", ")}`).toBe(true);
    expect(res.body.user.username).toBe(testUser.username);
  });

  it("POST /api/auth/logout returns valid response", async () => {
    const res = await getAgent()
      .post("/api/auth/logout")
      .set("Authorization", `Bearer ${authToken}`)
      .expect(200);

    const validation = validateSchema(logoutResponse, res.body);
    expect(validation.success, `Schema mismatch: ${validation.issues.join(", ")}`).toBe(true);
  });
});
