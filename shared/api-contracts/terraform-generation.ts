import { z } from "zod";

// POST /api/sessions/:id/generate-terraform
export const generateTerraformBody = z.object({
  description: z.string().optional(),
  cloudProvider: z.string().optional(),
  moduleApproach: z.string().optional(),
}).passthrough().openapi("GenerateTerraformBody");

/** POST /api/sessions/:id/terraform-cli-repair — optional context for variable sync after repair */
export const terraformCliRepairBody = z
  .object({
    description: z.string().optional(),
  })
  .passthrough()
  .openapi("TerraformCliRepairBody");

/** POST /api/sessions/:id/terraform-cicd-repair — AI fix from GitHub Actions plan/validate logs */
export const terraformCicdRepairBody = z
  .object({
    planLogs: z.string().min(1, "planLogs is required"),
    description: z.string().optional(),
  })
  .passthrough()
  .openapi("TerraformCicdRepairBody");

export const terraformCliCheckSchema = z
  .object({
    ran: z.boolean().optional(),
    skippedReason: z.string().optional(),
    initOk: z.boolean().optional(),
    validateOk: z.boolean().optional(),
    diagnostics: z
      .array(
        z.object({
          severity: z.string().optional(),
          summary: z.string().optional(),
          detail: z.string().optional(),
        }),
      )
      .optional(),
  })
  .passthrough();

/** Saved session files plus optional terraform init/validate results (when CLI available). */
export const terraformCliRepairMetaSchema = z
  .object({
    attempted: z.boolean().optional(),
    succeeded: z.boolean().optional(),
  })
  .passthrough();

export const generateTerraformResponse = z
  .object({
    files: z.array(z.object({ id: z.string(), fileName: z.string(), content: z.string() }).passthrough()),
    terraformCliCheck: terraformCliCheckSchema.optional(),
    terraformCliRepair: terraformCliRepairMetaSchema.optional(),
  })
  .passthrough()
  .openapi("GenerateTerraformResponse");

export const terraformCliRepairResponse = z
  .object({
    success: z.boolean(),
    message: z.string().optional(),
    terraformCliCheck: terraformCliCheckSchema.optional(),
    terraformCliRepair: terraformCliRepairMetaSchema.optional(),
    files: z.array(z.object({ id: z.string(), fileName: z.string(), content: z.string() }).passthrough()),
  })
  .passthrough()
  .openapi("TerraformCliRepairResponse");

export const terraformCicdRepairResponse = z
  .object({
    success: z.boolean(),
    message: z.string().optional(),
  })
  .passthrough()
  .openapi("TerraformCicdRepairResponse");
