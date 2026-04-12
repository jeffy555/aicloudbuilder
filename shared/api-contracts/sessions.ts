import { z } from "zod";

const sessionSchema = z.object({
  id: z.string(),
  userId: z.string().nullable(),
  provider: z.string().nullable(),
  repositoryId: z.string().nullable(),
  repositoryName: z.string().nullable(),
  repositoryBranch: z.string().nullable(),
  cloudProvider: z.string().nullable(),
  moduleApproach: z.string().nullable(),
  currentStep: z.string(),
  workflowStep: z.string(),
  activeModule: z.string().nullable(),
  isExistingRepo: z.string().nullable(),
  detectedCloudProvider: z.string().nullable(),
  detectedModuleType: z.string().nullable(),
  detectedTerraformFiles: z.any().nullable(),
  archMeAnalysis: z.string().nullable(),
  hasBackend: z.string().nullable(),
  backendType: z.string().nullable(),
  backendStorageAccount: z.string().nullable(),
  backendResourceGroup: z.string().nullable(),
  backendContainer: z.string().nullable(),
  backendStateKey: z.string().nullable(),
  backendLocation: z.string().nullable(),
  backendValidated: z.string().nullable(),
  backendDeclined: z.string().nullable(),
  scannedResources: z.string().nullable(),
  scanTimestamp: z.string().nullable(),
  selectedResourceGroups: z.string().nullable(),
  usageMetricsCache: z.string().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
}).openapi("Session");

// POST /api/sessions — no body required
export const createSessionResponse = sessionSchema;

// GET /api/sessions/:id
export const getSessionResponse = sessionSchema;

// PATCH /api/sessions/:id
export const updateSessionBody = z.object({
  provider: z.string().optional(),
  repositoryId: z.string().optional(),
  repositoryName: z.string().optional(),
  repositoryBranch: z.string().optional(),
  cloudProvider: z.string().optional(),
  moduleApproach: z.string().optional(),
  currentStep: z.string().optional(),
  workflowStep: z.string().optional(),
  activeModule: z.string().optional(),
}).passthrough().openapi("UpdateSessionBody");

export const updateSessionResponse = sessionSchema;

// POST /api/sessions/:id/reset
export const resetSessionBody = z.object({
  clearFiles: z.boolean().default(true).optional(),
  resetState: z.boolean().default(false).optional(),
  keepProvider: z.boolean().default(true).optional(),
}).openapi("ResetSessionBody");

export const resetSessionResponse = z.object({
  success: z.literal(true),
  message: z.string(),
  filesCleared: z.number(),
  stateReset: z.boolean(),
  session: sessionSchema.nullable(),
}).openapi("ResetSessionResponse");

// GET /api/sessions/:id/messages
const messageSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  type: z.string(),
  content: z.string(),
  createdAt: z.coerce.date(),
}).openapi("Message");

export const getMessagesResponse = z.array(messageSchema).openapi("MessagesResponse");

// POST /api/sessions/:id/messages/system
export const systemMessageBody = z.object({
  message: z.string().min(1),
}).openapi("SystemMessageBody");

export const systemMessageResponse = z.object({
  aiMessage: messageSchema,
}).openapi("SystemMessageResponse");

// POST /api/sessions/:id/chat
export const chatBody = z.object({
  message: z.string().min(1),
}).openapi("ChatBody");

export const chatResponse = z.object({
  userMessage: messageSchema,
  aiMessage: messageSchema,
  autoGenerationTriggered: z.boolean().optional(),
}).openapi("ChatResponse");

// GET /api/sessions/:id/files-debug
export const filesDebugResponse = z.object({
  sessionId: z.string(),
  sessionExists: z.boolean(),
  fileCount: z.number(),
  files: z.array(z.object({
    id: z.string(),
    fileName: z.string(),
    contentLength: z.number(),
    sessionId: z.string(),
  })),
  sessionInfo: z.object({
    moduleType: z.string().nullable(),
    hasResources: z.string().nullable(),
    moduleApproach: z.string().nullable(),
  }).nullable(),
}).openapi("FilesDebugResponse");
