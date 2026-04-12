/**
 * Contract test: OpenAPI Spec
 * Validates that the OpenAPI spec is generated correctly and served at runtime.
 */
import { describe, it, expect } from "vitest";
import { getAgent } from "./helpers/contract-utils";

describe("OpenAPI Spec Contract", () => {
  it("GET /api/openapi.json returns valid OpenAPI 3.0 spec", async () => {
    const res = await getAgent().get("/api/openapi.json").expect(200);

    expect(res.body.openapi).toBe("3.0.3");
    expect(res.body.info.title).toBe("AICloudBuilder API");
    expect(res.body.info.version).toBeDefined();
    expect(res.body.paths).toBeDefined();
    expect(res.body.components?.schemas).toBeDefined();

    // Verify key paths exist
    const paths = Object.keys(res.body.paths);
    expect(paths).toContain("/api/health");
    expect(paths).toContain("/api/auth/signup");
    expect(paths).toContain("/api/auth/login");
    expect(paths).toContain("/api/sessions");
    expect(paths).toContain("/api/sessions/{id}");
    expect(paths).toContain("/api/sessions/{id}/files");
    expect(paths).toContain("/api/sessions/{id}/chat");

    // Verify minimum path count (we registered 110)
    expect(paths.length).toBeGreaterThanOrEqual(100);
  });

  it("Spec contains schema definitions for key types", async () => {
    const res = await getAgent().get("/api/openapi.json").expect(200);
    const schemas = Object.keys(res.body.components?.schemas || {});

    expect(schemas).toContain("ErrorResponse");
    expect(schemas).toContain("Session");
    expect(schemas).toContain("SignupBody");
    expect(schemas).toContain("LoginBody");
    expect(schemas).toContain("ChatBody");
  });
});
