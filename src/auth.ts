import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Generates a random salt for password hashing
 * @returns A random salt string
 */
export function generateSalt(): string {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Hashes a password with the given salt
 * @param password The password to hash
 * @param salt The salt to use
 * @returns The hashed password
 */
export function hashPassword(password: string, salt: string): string {
  return crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
}

/**
 * Verifies a password against a stored hash and salt
 * @param password The password to verify
 * @param hash The stored hash
 * @param salt The stored salt
 * @returns True if the password is correct, false otherwise
 */
export function verifyPassword(
  password: string,
  hash: string,
  salt: string
): boolean {
  const hashedPassword = hashPassword(password, salt);
  return hashedPassword === hash;
}

/**
 * Generates a JWT token for a user
 * @param userId The user ID to include in the token
 * @param userGroups Optional array of user group names
 * @param companyId Optional company ID the user belongs to
 * @returns A JWT token
 */
export function generateToken(
  userId: string,
  userGroups: string[] = [],
  companyId?: number
): string {
  const secret = process.env.JWT_SECRET!;
  return jwt.sign({ userId, userGroups, companyId }, secret, {
    expiresIn: '1y',
  });
}

/**
 * Verifies a JWT token
 * @param token The token to verify
 * @returns The decoded token payload or null if invalid
 */
export function verifyToken(token: string): any {
  const secret = process.env.JWT_SECRET!;
  try {
    return jwt.verify(token, secret);
  } catch (e) {
    return null;
  }
}

/**
 * Authenticates a user with email and password
 * @param email The user's email
 * @param password The user's password
 * @returns A token if authentication is successful, null otherwise
 */
export async function authenticateUser(
  email: string,
  password: string
): Promise<{ token: string; userId: string } | null> {
  try {
    // First get the full user record
    const user = await prisma.user.findUnique({
      where: { email },
      include: {
        UserGroupUser: {
          include: {
            UserGroup: true,
          },
        },
      },
    });

    if (!user) {
      return null;
    }

    // Check if user has password and salt fields
    if (!user.password || !user.salt) {
      return null;
    }

    const isValid = verifyPassword(password, user.password, user.salt);
    if (!isValid) {
      return null;
    }

    // Extract user group names
    const userGroups = user.UserGroupUser.map((ugu) => ugu.UserGroup.name);

    const token = generateToken(
      user.userId,
      userGroups,
      user.companyId || undefined
    );

    return { token, userId: user.userId };
  } catch (error) {
    console.error('Authentication error:', error);
    return null;
  }
}

/**
 * Creates a new admin user or updates an existing one
 * @param email The admin's email
 * @param password The admin's password
 * @param displayName The admin's display name
 * @returns The created or updated user
 */
/**
 * Gets all user groups for a specific user
 * @param userId The user's ID
 * @returns Array of user group names
 */
export async function getUserGroups(userId: string): Promise<string[]> {
  try {
    const user = await prisma.user.findUnique({
      where: { userId },
      include: {
        UserGroupUser: {
          include: {
            UserGroup: true,
          },
        },
      },
    });

    if (!user) {
      return [];
    }

    return user.UserGroupUser.map((ugu) => ugu.UserGroup.name);
  } catch (error) {
    console.error('Error getting user groups:', error);
    return [];
  }
}

export async function createOrUpdateAdminUser(
  email: string,
  password: string,
  displayName: string
): Promise<any> {
  const salt = generateSalt();
  const hashedPassword = hashPassword(password, salt);
  const userId = crypto.randomUUID();
  const userHash = crypto.randomBytes(16).toString('hex');

  try {
    // Check if user exists
    const existingUser = await prisma.user.findUnique({
      where: { email },
      include: {
        UserGroupUser: {
          include: {
            UserGroup: true,
          },
        },
      },
    });

    if (existingUser) {
      // Update existing user using raw SQL to bypass Prisma type checking
      // This is a temporary solution until Prisma client is regenerated
      await prisma.$executeRaw`
        UPDATE users 
        SET password = ${hashedPassword}, 
            salt = ${salt}, 
            displayName = ${displayName} 
        WHERE email = ${email}
      `;

      // Fetch the updated user
      return await prisma.user.findUnique({
        where: { email },
        include: {
          UserGroupUser: {
            include: {
              UserGroup: true,
            },
          },
        },
      });
    } else {
      // Create new user using raw SQL to bypass Prisma type checking
      // This is a temporary solution until Prisma client is regenerated
      await prisma.$executeRaw`
        INSERT INTO users (userId, email, displayName, hash, password, salt, marketingEmails, sync, createdAt, updatedAt)
        VALUES (
          ${userId}, 
          ${email}, 
          ${displayName}, 
          ${userHash}, 
          ${hashedPassword}, 
          ${salt}, 
          0, 
          0, 
          NOW(), 
          NOW()
        )
      `;

      // Fetch the created user
      return await prisma.user.findUnique({
        where: { email },
        include: {
          UserGroupUser: {
            include: {
              UserGroup: true,
            },
          },
        },
      });
    }
  } catch (error) {
    console.error('Error creating/updating admin user:', error);
    throw error;
  }
}
