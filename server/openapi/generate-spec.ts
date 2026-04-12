/**
 * Build-time script: generates shared/openapi.json from the registry.
 * Run with: npx tsx server/openapi/generate-spec.ts
 */
// Setup MUST come first — extends Zod with .openapi() before any contract is loaded
import "@shared/api-contracts/setup";

import { writeFileSync } from "fs";
import { resolve } from "path";
import { generateOpenAPIDocument } from "./registry";

const doc = generateOpenAPIDocument();
const outPath = resolve(import.meta.dirname, "../../shared/openapi.json");
writeFileSync(outPath, JSON.stringify(doc, null, 2), "utf-8");

const pathCount = Object.keys(doc.paths || {}).length;
const schemaCount = Object.keys(doc.components?.schemas || {}).length;

console.log(`✅ OpenAPI spec generated: ${outPath}`);
console.log(`   ${pathCount} paths, ${schemaCount} schemas`);
