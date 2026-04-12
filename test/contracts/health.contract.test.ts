/**
 * Contract test: Health endpoint
 * Validates GET /api/health response matches the OpenAPI contract.
 */
import { describe, it, expect } from "vitest";
import { getAgent, validateSchema } from "./helpers/contract-utils";
import { healthResponse } from "@shared/api-contracts/health";

describe("Health Contract", () => {
  it("GET /api/health returns valid response", async () => {
    const res = await getAgent().get("/api/health").expect(200);

    const validation = validateSchema(healthResponse, res.body);
    expect(validation.success, `Schema mismatch: ${validation.issues.join(", ")}`).toBe(true);
    expect(res.body.status).toBe("ok");
    expect(res.body.timestamp).toBeDefined();
  });
});
