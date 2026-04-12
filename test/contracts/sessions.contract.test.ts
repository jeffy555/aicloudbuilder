/**
 * Contract test: Sessions endpoints
 * Validates CRUD + chat responses match the OpenAPI contract.
 */
import { describe, it, expect } from "vitest";
import { getAgent, validateSchema } from "./helpers/contract-utils";
import {
  createSessionResponse,
  getSessionResponse,
  updateSessionResponse,
  resetSessionResponse,
  getMessagesResponse,
  filesDebugResponse,
} from "@shared/api-contracts/sessions";
import { errorResponse } from "@shared/api-contracts/common";

describe("Sessions Contract", () => {
  let sessionId: string;

  it("POST /api/sessions creates session with valid response", async () => {
    const res = await getAgent().post("/api/sessions").expect(200);

    const validation = validateSchema(createSessionResponse, res.body);
    expect(validation.success, `Schema mismatch: ${validation.issues.join(", ")}`).toBe(true);
    expect(res.body.id).toBeDefined();
    sessionId = res.body.id;
  });

  it("GET /api/sessions/:id returns valid response", async () => {
    const res = await getAgent().get(`/api/sessions/${sessionId}`).expect(200);

    const validation = validateSchema(getSessionResponse, res.body);
    expect(validation.success, `Schema mismatch: ${validation.issues.join(", ")}`).toBe(true);
    expect(res.body.id).toBe(sessionId);
  });

  it("GET /api/sessions/:id returns 404 for missing session", async () => {
    const res = await getAgent().get("/api/sessions/nonexistent-id").expect(404);

    const validation = validateSchema(errorResponse, res.body);
    expect(validation.success, `Schema mismatch: ${validation.issues.join(", ")}`).toBe(true);
  });

  it("PATCH /api/sessions/:id returns valid response", async () => {
    const res = await getAgent()
      .patch(`/api/sessions/${sessionId}`)
      .send({ cloudProvider: "azure" })
      .expect(200);

    const validation = validateSchema(updateSessionResponse, res.body);
    expect(validation.success, `Schema mismatch: ${validation.issues.join(", ")}`).toBe(true);
  });

  it("POST /api/sessions/:id/reset returns valid response", async () => {
    const res = await getAgent()
      .post(`/api/sessions/${sessionId}/reset`)
      .send({ clearFiles: true, resetState: false })
      .expect(200);

    const validation = validateSchema(resetSessionResponse, res.body);
    expect(validation.success, `Schema mismatch: ${validation.issues.join(", ")}`).toBe(true);
    expect(res.body.success).toBe(true);
  });

  it("GET /api/sessions/:id/messages returns valid response", async () => {
    const res = await getAgent()
      .get(`/api/sessions/${sessionId}/messages`)
      .expect(200);

    const validation = validateSchema(getMessagesResponse, res.body);
    expect(validation.success, `Schema mismatch: ${validation.issues.join(", ")}`).toBe(true);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("GET /api/sessions/:id/files-debug returns valid response", async () => {
    const res = await getAgent()
      .get(`/api/sessions/${sessionId}/files-debug`)
      .expect(200);

    const validation = validateSchema(filesDebugResponse, res.body);
    expect(validation.success, `Schema mismatch: ${validation.issues.join(", ")}`).toBe(true);
    expect(res.body.sessionId).toBe(sessionId);
  });
});
