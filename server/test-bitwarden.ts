import { BitwardenClient } from "@bitwarden/sdk-napi";
import dotenv from "dotenv";
dotenv.config();

const ACCESS_TOKEN = process.env.BITWARDEN_ACCESS_TOKEN || "";
const PROJECT_ID = process.env.BITWARDEN_PROJECT_ID || "";

async function testBitwarden() {
  const client = new BitwardenClient();
  console.log("📡 Authenticating...");
  await client.auth().loginAccessToken(ACCESS_TOKEN);
  
  // Get Org ID from the first project we can list
  console.log("📡 Listing projects...");
  // Note: list() requires organizationId... wait, how do I get it if I don't have it?
  // Ah, the project get() worked, so we have it.
  
  const project = await client.projects().get(PROJECT_ID);
  const orgId = project.organizationId;
  console.log(`✅ Organization ID: ${orgId}`);

  console.log("\n📡 Listing ALL projects for this Org:");
  const projects = await client.projects().list(orgId);
  projects.data.forEach(p => {
    console.log(`- Name: ${p.name}, ID: ${p.id}, Org: ${p.organizationId}`);
  });

  const testKey = `test_secret_${Date.now()}`;
  const testValue = "test_value";

  console.log(`\n🚀 Final attempt with verified IDs:`);
  try {
    const result = await client.secrets().create(
      orgId,
      testKey,
      testValue,
      "Test Note",
      [PROJECT_ID]
    );
    console.log(`✅ SUCCESS! Created ID: ${result.id}`);
  } catch (error: any) {
    console.error(`❌ FAILED: ${error.message}`);
  }
}

testBitwarden().catch(console.error);
