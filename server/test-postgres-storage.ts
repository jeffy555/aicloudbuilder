import "dotenv/config";
import { storage } from "./storage";
import { db } from "./db";

async function testPostgreSQLStorage() {
  console.log("\n🧪 Testing PostgreSQL Storage Integration\n");
  console.log("=" .repeat(50));

  // Test 1: Check which storage is being used
  console.log("\n📋 Test 1: Storage Type Check");
  console.log("-".repeat(50));
  const storageType = process.env.DATABASE_URL ? "PostgreSQL" : "In-Memory";
  console.log(`✅ Storage Type: ${storageType}`);
  console.log(`   DATABASE_URL: ${process.env.DATABASE_URL ? "✅ Set" : "❌ Not Set"}`);
  
  if (!process.env.DATABASE_URL) {
    console.log("\n⚠️  WARNING: DATABASE_URL not set. Using in-memory storage.");
    return;
  }

  // Test 2: Test database connection
  console.log("\n📋 Test 2: Database Connection");
  console.log("-".repeat(50));
  try {
    const result = await db.execute("SELECT 1 as test");
    console.log("✅ Database connection: SUCCESS");
  } catch (error: any) {
    console.log("❌ Database connection: FAILED");
    console.log(`   Error: ${error.message}`);
    return;
  }

  // Test 3: Create a test session
  console.log("\n📋 Test 3: Create Test Session");
  console.log("-".repeat(50));
  let testSessionId: string;
  try {
    const session = await storage.createSession({
      provider: "github",
      cloudProvider: "azure",
      currentStep: "1",
      workflowStep: "landing",
    });
    testSessionId = session.id;
    console.log(`✅ Session created: ${testSessionId}`);
    console.log(`   Provider: ${session.provider}`);
    console.log(`   Cloud Provider: ${session.cloudProvider}`);
    console.log(`   Created At: ${session.createdAt}`);
  } catch (error: any) {
    console.log("❌ Session creation: FAILED");
    console.log(`   Error: ${error.message}`);
    return;
  }

  // Test 4: Retrieve the session
  console.log("\n📋 Test 4: Retrieve Test Session");
  console.log("-".repeat(50));
  try {
    const retrievedSession = await storage.getSession(testSessionId);
    if (retrievedSession) {
      console.log(`✅ Session retrieved: ${retrievedSession.id}`);
      console.log(`   Provider: ${retrievedSession.provider}`);
      console.log(`   Cloud Provider: ${retrievedSession.cloudProvider}`);
    } else {
      console.log("❌ Session not found");
      return;
    }
  } catch (error: any) {
    console.log("❌ Session retrieval: FAILED");
    console.log(`   Error: ${error.message}`);
    return;
  }

  // Test 5: Update the session
  console.log("\n📋 Test 5: Update Test Session");
  console.log("-".repeat(50));
  try {
    const updatedSession = await storage.updateSession(testSessionId, {
      currentStep: "2",
      workflowStep: "provider_selection",
    });
    console.log(`✅ Session updated: ${updatedSession.id}`);
    console.log(`   Current Step: ${updatedSession.currentStep}`);
    console.log(`   Workflow Step: ${updatedSession.workflowStep}`);
    console.log(`   Updated At: ${updatedSession.updatedAt}`);
  } catch (error: any) {
    console.log("❌ Session update: FAILED");
    console.log(`   Error: ${error.message}`);
    return;
  }

  // Test 6: Create a test message
  console.log("\n📋 Test 6: Create Test Message");
  console.log("-".repeat(50));
  try {
    const message = await storage.createMessage({
      sessionId: testSessionId,
      type: "user",
      content: "Test message for PostgreSQL storage",
    });
    console.log(`✅ Message created: ${message.id}`);
    console.log(`   Type: ${message.type}`);
    console.log(`   Content: ${message.content.substring(0, 50)}...`);
  } catch (error: any) {
    console.log("❌ Message creation: FAILED");
    console.log(`   Error: ${error.message}`);
    return;
  }

  // Test 7: Retrieve messages
  console.log("\n📋 Test 7: Retrieve Messages");
  console.log("-".repeat(50));
  try {
    const messages = await storage.getMessagesBySession(testSessionId);
    console.log(`✅ Messages retrieved: ${messages.length} message(s)`);
    messages.forEach((msg, index) => {
      console.log(`   ${index + 1}. [${msg.type}] ${msg.content.substring(0, 40)}...`);
    });
  } catch (error: any) {
    console.log("❌ Message retrieval: FAILED");
    console.log(`   Error: ${error.message}`);
    return;
  }

  // Test 8: Create a test file
  console.log("\n📋 Test 8: Create Test File");
  console.log("-".repeat(50));
  try {
    const file = await storage.createFile({
      sessionId: testSessionId,
      fileName: "test.tf",
      content: "# Test Terraform file\nresource \"azurerm_resource_group\" \"test\" {}",
    });
    console.log(`✅ File created: ${file.id}`);
    console.log(`   File Name: ${file.fileName}`);
    console.log(`   Content Length: ${file.content.length} characters`);
  } catch (error: any) {
    console.log("❌ File creation: FAILED");
    console.log(`   Error: ${error.message}`);
    return;
  }

  // Test 9: Retrieve files
  console.log("\n📋 Test 9: Retrieve Files");
  console.log("-".repeat(50));
  try {
    const files = await storage.getFilesBySession(testSessionId);
    console.log(`✅ Files retrieved: ${files.length} file(s)`);
    files.forEach((file, index) => {
      console.log(`   ${index + 1}. ${file.fileName} (${file.content.length} chars)`);
    });
  } catch (error: any) {
    console.log("❌ File retrieval: FAILED");
    console.log(`   Error: ${error.message}`);
    return;
  }

  // Test 10: Verify data in PostgreSQL directly
  console.log("\n📋 Test 10: Verify Data in PostgreSQL");
  console.log("-".repeat(50));
  try {
    const { sessions, messages, generatedFiles } = await import("@shared/schema");
    const { eq } = await import("drizzle-orm");
    
    const dbSession = await db.select().from(sessions).where(eq(sessions.id, testSessionId)).limit(1);
    const dbMessages = await db.select().from(messages).where(eq(messages.sessionId, testSessionId));
    const dbFiles = await db.select().from(generatedFiles).where(eq(generatedFiles.sessionId, testSessionId));
    
    console.log(`✅ Direct database query successful:`);
    console.log(`   Sessions in DB: ${dbSession.length}`);
    console.log(`   Messages in DB: ${dbMessages.length}`);
    console.log(`   Files in DB: ${dbFiles.length}`);
    
    if (dbSession.length > 0 && dbMessages.length > 0 && dbFiles.length > 0) {
      console.log("\n🎉 SUCCESS: Data is stored in PostgreSQL!");
      console.log("   ✅ Session persisted");
      console.log("   ✅ Messages persisted");
      console.log("   ✅ Files persisted");
    } else {
      console.log("\n⚠️  WARNING: Some data not found in database");
    }
  } catch (error: any) {
    console.log("❌ Direct database query: FAILED");
    console.log(`   Error: ${error.message}`);
  }

  console.log("\n" + "=".repeat(50));
  console.log("✅ All tests completed!");
  console.log(`\n📝 Test Session ID: ${testSessionId}`);
  console.log("   You can verify this in pgAdmin:");
  console.log("   1. Open pgAdmin 4");
  console.log("   2. Connect to aicloudops database");
  console.log("   3. Check sessions, messages, and generated_files tables");
  console.log(`   4. Look for session ID: ${testSessionId}\n`);
  
  process.exit(0);
}

testPostgreSQLStorage().catch((error) => {
  console.error("\n❌ Test failed with error:", error);
  process.exit(1);
});

