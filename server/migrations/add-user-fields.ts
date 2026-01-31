import "dotenv/config";
import { db } from '../db';
import { sql } from 'drizzle-orm';

async function addUserFields() {
  console.log('🔄 Adding email, createdAt, updatedAt fields to users table...');
  
  try {
    // Check if email column exists
    const checkEmail = await db.execute(sql`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'users' AND column_name = 'email'
    `);
    
    if (checkEmail.rows.length === 0) {
      // Add email column
      await db.execute(sql`
        ALTER TABLE users 
        ADD COLUMN email TEXT UNIQUE
      `);
      console.log('✅ Added email column');
    } else {
      console.log('ℹ️  Email column already exists');
    }
    
    // Check if createdAt column exists
    const checkCreatedAt = await db.execute(sql`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'users' AND column_name = 'created_at'
    `);
    
    if (checkCreatedAt.rows.length === 0) {
      // Add createdAt column
      await db.execute(sql`
        ALTER TABLE users 
        ADD COLUMN created_at TIMESTAMP DEFAULT NOW() NOT NULL
      `);
      console.log('✅ Added created_at column');
    } else {
      console.log('ℹ️  created_at column already exists');
    }
    
    // Check if updatedAt column exists
    const checkUpdatedAt = await db.execute(sql`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'users' AND column_name = 'updated_at'
    `);
    
    if (checkUpdatedAt.rows.length === 0) {
      // Add updatedAt column
      await db.execute(sql`
        ALTER TABLE users 
        ADD COLUMN updated_at TIMESTAMP DEFAULT NOW() NOT NULL
      `);
      console.log('✅ Added updated_at column');
    } else {
      console.log('ℹ️  updated_at column already exists');
    }
    
    console.log('✅ Migration completed successfully!');
  } catch (error: any) {
    console.error('❌ Migration failed:', error.message);
    throw error;
  }
}

addUserFields()
  .then(() => {
    console.log('✅ Done!');
    process.exit(0);
  })
  .catch((err) => {
    console.error('❌ Failed:', err);
    process.exit(1);
  });

