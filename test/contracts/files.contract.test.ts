/**
 * Contract test: Files endpoints
 * Validates file CRUD responses match the OpenAPI contract.
 */
import { describe, it, expect } from "vitest";
import { getAgent, validateSchema } from "./helpers/contract-utils";
import {
  getFilesResponse,
  createFileResponse,
  bulkFilesResponse,
} from "@shared/api-contracts/files";

describe("Files Contract", () => {
  let sessionId: string;

  it("setup: create session", async () => {
    const res = await getAgent().post("/api/sessions").expect(200);
    sessionId = res.body.id;
  });

  it("GET /api/sessions/:id/files returns valid response", async () => {
    const res = await getAgent()
      .get(`/api/sessions/${sessionId}/files`)
      .expect(200);

    const validation = validateSchema(getFilesResponse, res.body);
    expect(validation.success, `Schema mismatch: ${validation.issues.join(", ")}`).toBe(true);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("POST /api/sessions/:id/files creates file with valid response", async () => {
    const res = await getAgent()
      .post(`/api/sessions/${sessionId}/files`)
      .send({ fileName: "main.tf", content: "resource {}" })
      .expect(201);

    const validation = validateSchema(createFileResponse, res.body);
    expect(validation.success, `Schema mismatch: ${validation.issues.join(", ")}`).toBe(true);
    expect(res.body.fileName).toBe("main.tf");
  });

  it("POST /api/sessions/:id/files/bulk returns valid response", async () => {
    const res = await getAgent()
      .post(`/api/sessions/${sessionId}/files/bulk`)
      .send({
        files: [
          { fileName: "vars.tf", content: "variable {}" },
          { fileName: "outputs.tf", content: "output {}" },
        ],
      })
      .expect(200);

    const validation = validateSchema(bulkFilesResponse, res.body);
    expect(validation.success, `Schema mismatch: ${validation.issues.join(", ")}`).toBe(true);
    expect(res.body.success).toBe(true);
    expect(res.body.total).toBe(2);
  });
});
