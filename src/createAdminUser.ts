import { createOrUpdateAdminUser } from './auth';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

async function createFirstAdmin() {
  try {
    // Default admin credentials - in production, these should be set via environment variables
    const email = process.env.ADMIN_EMAIL || 'admin@example.com';
    const password = process.env.ADMIN_PASSWORD || 'StrongPassword123!';
    const displayName = process.env.ADMIN_NAME || 'System Administrator';
    
    console.log('Creating admin user...');
    const user = await createOrUpdateAdminUser(email, password, displayName);
    
    console.log('Admin user created successfully:');
    console.log('Email:', email);
    console.log('User ID:', user.userId);
    console.log('Password hash:', user.password);
    console.log('Salt:', user.salt);
    
    console.log('\nIMPORTANT: Store these credentials securely and change the password in production!');
    
    process.exit(0);
  } catch (error) {
    console.error('Error creating admin user:', error);
    process.exit(1);
  }
}

createFirstAdmin();
