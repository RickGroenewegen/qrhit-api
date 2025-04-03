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
export function verifyPassword(password: string, hash: string, salt: string): boolean {
  const hashedPassword = hashPassword(password, salt);
  return hashedPassword === hash;
}

/**
 * Generates a JWT token for a user
 * @param userId The user ID to include in the token
 * @param isAdmin Whether the user is an admin
 * @returns A JWT token
 */
export function generateToken(userId: string, isAdmin: boolean = false): string {
  const secret = process.env.JWT_SECRET!;
  return jwt.sign({ userId, isAdmin }, secret, { expiresIn: '1y' });
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
export async function authenticateUser(email: string, password: string): Promise<{ token: string, userId: string } | null> {
  try {
    const user = await prisma.user.findUnique({
      where: { email },
      select: {
        userId: true,
        password: true,
        salt: true,
        isAdmin: true
      }
    });

    if (!user || !user.password || !user.salt) {
      return null;
    }

    const isValid = verifyPassword(password, user.password, user.salt);
    if (!isValid) {
      return null;
    }

    const token = generateToken(user.userId, user.isAdmin);
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
export async function createOrUpdateAdminUser(email: string, password: string, displayName: string): Promise<any> {
  const salt = generateSalt();
  const hashedPassword = hashPassword(password, salt);
  const userId = crypto.randomUUID();
  const userHash = crypto.randomBytes(16).toString('hex');

  try {
    // Check if user exists
    const existingUser = await prisma.user.findUnique({
      where: { email }
    });

    if (existingUser) {
      // Update existing user
      return await prisma.user.update({
        where: { email },
        data: {
          password: hashedPassword,
          salt: salt,
          isAdmin: true,
          displayName
        }
      });
    } else {
      // Create new user
      return await prisma.user.create({
        data: {
          userId,
          email,
          displayName,
          hash: userHash,
          password: hashedPassword,
          salt: salt,
          isAdmin: true
        }
      });
    }
  } catch (error) {
    console.error('Error creating/updating admin user:', error);
    throw error;
  }
}
