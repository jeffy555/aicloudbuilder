/**
 * Docker Compose Generator
 * Generates docker-compose.yml using AI based on repo scan data and Dockerfile content.
 */
import { aiChatCompletion } from '../utils/ai-client.js';
import { z } from 'zod';
import { sanitizeField, sanitizeContent } from '../utils/sanitize-prompt.js';

// ─── Zod schemas for AI response validation ─────────────────────────────────

const aiImageSizeSchema = z.object({
  compressed: z.number(),
  uncompressed: z.number(),
});

export interface ComposeGenerateOptions {
  projectName: string;
  languages: string[];
  frameworks: string[];
  entrypoint?: string;
  existingDockerfileContent?: string;
}

export interface ComposeGenerateResult {
  content: string;
  services: string[];
}

// ── Static image size lookup table ────────────────────────────────────────────
// Values in MB (compressed/pulled, uncompressed/on-disk)
const IMAGE_SIZES: Record<string, { compressed: number; uncompressed: number }> = {
  'node:20-alpine':        { compressed: 55,  uncompressed: 180 },
  'node:20-slim':          { compressed: 95,  uncompressed: 330 },
  'node:20':               { compressed: 135, uncompressed: 490 },
  'node:18-alpine':        { compressed: 50,  uncompressed: 170 },
  'node:18-slim':          { compressed: 90,  uncompressed: 315 },
  'node:18':               { compressed: 130, uncompressed: 470 },
  'python:3.12-slim':      { compressed: 45,  uncompressed: 125 },
  'python:3.12-alpine':    { compressed: 20,  uncompressed: 55  },
  'python:3.12':           { compressed: 130, uncompressed: 430 },
  'python:3.11-slim':      { compressed: 43,  uncompressed: 120 },
  'python:3.11-alpine':    { compressed: 19,  uncompressed: 52  },
  'golang:1.22-alpine':    { compressed: 70,  uncompressed: 240 },
  'golang:1.22':           { compressed: 185, uncompressed: 650 },
  'golang:1.21-alpine':    { compressed: 68,  uncompressed: 235 },
  'eclipse-temurin:21-jdk':{ compressed: 220, uncompressed: 660 },
  'eclipse-temurin:21-jre':{ compressed: 100, uncompressed: 280 },
  'eclipse-temurin:17-jdk':{ compressed: 210, uncompressed: 630 },
  'eclipse-temurin:17-jre':{ compressed: 95,  uncompressed: 265 },
  'ruby:3.3-alpine':       { compressed: 35,  uncompressed: 95  },
  'ruby:3.3-slim':         { compressed: 90,  uncompressed: 275 },
  'php:8.3-fpm-alpine':    { compressed: 35,  uncompressed: 95  },
  'php:8.3-fpm':           { compressed: 110, uncompressed: 360 },
  'rust:alpine':           { compressed: 70,  uncompressed: 225 },
  'rust:slim':             { compressed: 160, uncompressed: 540 },
  'nginx:alpine':          { compressed: 12,  uncompressed: 45  },
  'nginx':                 { compressed: 55,  uncompressed: 190 },
  'httpd:alpine':          { compressed: 25,  uncompressed: 60  },
  'alpine':                { compressed: 3,   uncompressed: 8   },
  'debian:bookworm-slim':  { compressed: 30,  uncompressed: 80  },
  'debian:bookworm':       { compressed: 55,  uncompressed: 135 },
  'ubuntu:22.04':          { compressed: 30,  uncompressed: 80  },
  'ubuntu:24.04':          { compressed: 32,  uncompressed: 85  },
  'distroless':            { compressed: 5,   uncompressed: 15  },
};

export interface ImageSizeEstimate {
  image: string;
  stage: string;
  compressedMB: number;
  uncompressedMB: number;
  isEstimated: boolean;
}

/**
 * Use AI to estimate compressed/uncompressed sizes for an unknown Docker image.
 * Returns null on failure so the caller can fall back to defaults.
 */
async function aiEstimateImageSize(
  imageName: string
): Promise<{ compressed: number; uncompressed: number } | null> {
  try {
    const response = await aiChatCompletion({
      model: "gpt-4o-mini",
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system" as const,
          content:
            'You are a Docker image size expert. Estimate the typical compressed (pulled) and uncompressed (on-disk) size in MB for a Docker image. Return JSON: { "compressed": <number>, "uncompressed": <number> }. Be realistic based on the image contents. If you are unsure, provide a reasonable estimate based on the image name, base OS, and typical contents.',
        },
        {
          role: "user" as const,
          content: `Estimate the compressed and uncompressed size in MB for this Docker image: ${imageName}`,
        },
      ],
    });

    const raw = response.choices[0]?.message?.content;
    if (!raw) return null;

    const result = aiImageSizeSchema.safeParse(JSON.parse(raw));
    if (!result.success) {
      console.warn('[compose-generator] AI image size response validation failed:', result.error.message);
      return null;
    }
    return result.data;
  } catch {
    return null;
  }
}

/**
 * Estimate final image sizes from a Dockerfile's FROM instructions.
 * Uses a static lookup table for known images and AI estimation for unknown ones.
 */
export async function estimateImageSizes(dockerfileContent: string): Promise<ImageSizeEstimate[]> {
  const lines = dockerfileContent.split('\n');
  const fromLines = lines.filter(l => l.trim().toUpperCase().startsWith('FROM'));
  const estimates: ImageSizeEstimate[] = [];
  const stages: string[] = [];

  for (const fromLine of fromLines) {
    const match = fromLine.match(/FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i);
    if (!match) continue;

    let image = match[1];
    const stageName = match[2] || `stage${stages.length}`;
    stages.push(stageName);

    // Match against lookup table (try exact, then base without digest/sha)
    const imageNormalized = image.replace(/@sha256:\w+$/, '').toLowerCase();
    let sizeData = IMAGE_SIZES[imageNormalized];

    // Try partial match (e.g. 'node:20-alpine' matches 'node:20-alpine' from the lookup)
    if (!sizeData) {
      const entry = Object.entries(IMAGE_SIZES).find(([key]) =>
        imageNormalized.startsWith(key.split(':')[0] + ':') ||
        imageNormalized === key
      );
      if (entry) sizeData = entry[1];
    }

    // For unknown images, try AI estimation before falling back to generic defaults
    if (!sizeData) {
      const aiEstimate = await aiEstimateImageSize(image);
      if (aiEstimate) {
        sizeData = aiEstimate;
      }
    }

    estimates.push({
      image,
      stage: stageName,
      compressedMB: sizeData?.compressed ?? 80,
      uncompressedMB: sizeData?.uncompressed ?? 250,
      isEstimated: !sizeData,
    });
  }

  // Return only the final stage (last FROM) for multi-stage builds
  return fromLines.length > 1
    ? estimates.slice(-1)  // only final stage matters for runtime
    : estimates;
}

/**
 * Generate docker-compose.yml using AI.
 */
export async function generateDockerCompose(
  options: ComposeGenerateOptions
): Promise<ComposeGenerateResult> {
  const contextLines: string[] = [
    `Project: ${sanitizeField(options.projectName)}`,
    `Languages: ${options.languages.map(l => sanitizeField(l)).join(', ') || 'unknown'}`,
    `Frameworks: ${options.frameworks.map(f => sanitizeField(f)).join(', ') || 'none detected'}`,
  ];
  if (options.entrypoint) contextLines.push(`Entry point: ${sanitizeField(options.entrypoint)}`);
  if (options.existingDockerfileContent) {
    contextLines.push(
      `\nExisting Dockerfile (first 800 chars):\n${sanitizeContent(options.existingDockerfileContent.substring(0, 800))}`
    );
  }

  const prompt = `${contextLines.join('\n')}

Generate a production-ready docker-compose.yml file for this application. Requirements:
- Use "version: '3.9'"
- Include an "app" service that builds from the local Dockerfile (build: .)
- Add supporting services (databases, caches) based on the detected frameworks:
  - Django/Flask/FastAPI → postgresql service
  - Spring Boot → mysql or postgresql service
  - Node.js + Prisma/Sequelize/TypeORM → postgresql service
  - Redis/caching keywords → redis service
  - Omit databases if no ORM or DB framework detected
- Configure a shared "app-network" bridge network
- Add named volumes for database persistence
- Set realistic placeholder ENV vars (use "changeme" for secrets)
- Expose appropriate ports (e.g., 3000, 8000, 8080)
- Add healthcheck for the main app service
- Use specific image versions (no :latest)

Return ONLY the docker-compose.yml content, no markdown fencing, no explanations.`;

  const completion = await aiChatCompletion({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content:
          'You are a Docker Compose expert. Generate clean, production-ready docker-compose.yml files. Return only raw YAML — no markdown fences, no explanations.',
      },
      { role: 'user', content: prompt },
    ],
    temperature: 0.2,
    max_tokens: 2000,
  });

  let content = completion.choices[0]?.message?.content?.trim() || '';

  // Strip markdown fencing if the AI included it anyway
  content = content
    .replace(/^```ya?ml\s*\n?/i, '')
    .replace(/^```\s*\n?/, '')
    .replace(/\n?```\s*$/, '');

  // Extract service names from top-level keys under "services:"
  const serviceMatches = content.match(/^  (\w[\w-]*):/gm) || [];
  const rawServices = serviceMatches.map((s) => s.trim().replace(':', ''));
  // Deduplicate without Set spread (TS compatibility)
  const services = rawServices.filter((s, i) => rawServices.indexOf(s) === i);

  return { content, services };
}
