import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import PrismaInstance from './prisma';

const prisma = PrismaInstance.getInstance();

// PBKDF2 iteration constants
const CURRENT_ITERATIONS = 600000;
const LEGACY_ITERATIONS = 10000;

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
 * @param iterations Number of PBKDF2 iterations (defaults to CURRENT_ITERATIONS)
 * @returns The hashed password
 */
export function hashPassword(
  password: string,
  salt: string,
  iterations: number = CURRENT_ITERATIONS
): string {
  return crypto
    .pbkdf2Sync(password, salt, iterations, 64, 'sha512')
    .toString('hex');
}

/**
 * Verifies a password against a stored hash and salt
 * @param password The password to verify
 * @param hash The stored hash
 * @param salt The stored salt
 * @param iterations Number of PBKDF2 iterations used for the stored hash
 * @returns True if the password is correct, false otherwise
 */
export function verifyPassword(
  password: string,
  hash: string,
  salt: string,
  iterations: number = LEGACY_ITERATIONS
): boolean {
  const hashedPassword = hashPassword(password, salt, iterations);
  return hashedPassword === hash;
}

/**
 * Generates a JWT token for a user
 * @param userId The user ID (email) to include in the token
 * @param userGroups Optional array of user group names
 * @param companyId Optional company ID the user belongs to
 * @param id Optional numeric user ID from database
 * @param displayName Optional display name of the user
 * @returns A JWT token
 */
export function generateToken(
  userId: string,
  userGroups: string[] = [],
  companyId?: number,
  id?: number,
  displayName?: string
): string {
  const secret = process.env.JWT_SECRET!;
  return jwt.sign({ userId, userGroups, companyId, id, displayName }, secret, {
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
 * Deletes a user by id
 * @param id The user's id
 * @returns {Promise<{ success: boolean; error?: string }>}
 */
export async function deleteUserById(
  id: number
): Promise<{ success: boolean; error?: string }> {
  try {
    await prisma.user.delete({
      where: { id },
    });
    return { success: true };
  } catch (error) {
    console.error('Error deleting user:', error);
    return { success: false, error: 'Failed to delete user' };
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
): Promise<{
  token: string;
  userId: string;
  userGroups: string[];
  companyId: number | undefined;
} | null> {
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

    // Check if user is verified
    if (!user.verified) {
      return null;
    }

    // Get the iteration count used for this user's password (default to legacy)
    const storedIterations = user.passwordIterations || LEGACY_ITERATIONS;

    const isValid = verifyPassword(
      password,
      user.password,
      user.salt,
      storedIterations
    );

    if (!isValid) {
      return null;
    }

    // Lazy rehashing: upgrade to current iterations if using legacy
    if (storedIterations < CURRENT_ITERATIONS) {
      try {
        const newSalt = generateSalt();
        const newHash = hashPassword(password, newSalt, CURRENT_ITERATIONS);
        await prisma.user.update({
          where: { id: user.id },
          data: {
            password: newHash,
            salt: newSalt,
            passwordIterations: CURRENT_ITERATIONS,
          },
        });
        console.log(
          `Upgraded password hash for user ${user.id} to ${CURRENT_ITERATIONS} iterations`
        );
      } catch (rehashError) {
        // Log but don't fail the login if rehashing fails
        console.error('Failed to rehash password:', rehashError);
      }
    }

    // Extract user group names
    const userGroups = user.UserGroupUser.map((ugu) => ugu.UserGroup.name);

    const token = generateToken(
      user.userId,
      userGroups,
      user.companyId || undefined,
      user.id,
      user.displayName || undefined
    );

    return {
      token,
      userId: user.userId,
      userGroups: userGroups,
      companyId: user.companyId || undefined,
    };
  } catch (error) {
    console.error('Authentication error:', error);
    return null;
  }
}

/**
 * Ensures a usergroup exists and connects a user to it
 * @param userId The user's database ID
 * @param groupName The name of the usergroup to connect the user to
 */
async function ensureUserInGroup(
  userId: number,
  groupName: string
): Promise<void> {
  try {
    // First, ensure the usergroup exists
    let userGroup = await prisma.userGroup.findUnique({
      where: { name: groupName },
    });

    if (!userGroup) {
      userGroup = await prisma.userGroup.create({
        data: { name: groupName },
      });
    }

    // Check if user is already in the group
    const existingConnection = await prisma.userInGroup.findFirst({
      where: {
        userId: userId,
        groupId: userGroup.id,
      },
    });

    // If not already connected, create the connection
    if (!existingConnection) {
      await prisma.userInGroup.create({
        data: {
          userId: userId,
          groupId: userGroup.id,
        },
      });
    }
  } catch (error) {
    console.error(`Error ensuring user is in ${groupName} group:`, error);
    // Don't throw here to avoid breaking the registration process
  }
}

/**
 * Creates a new admin user or updates an existing one
 * @param email The admin's email
 * @param password The admin's password
 * @param displayName The admin's display name
 * @returns The created or updated user
 */
export async function createOrUpdateAdminUser(
  email: string,
  password: string,
  displayName: string,
  companyId?: number,
  userGroup?: string,
  id?: number,
  currentUserGroups?: string[], // Pass the current user's groups for permission check
  phone?: string | null
): Promise<any> {
  const userId = email;
  const userHash = crypto.randomBytes(16).toString('hex');
  // The order of this array defines the hierarchy: first is highest
  const groupRank = ['admin', 'companyadmin'];

  try {
    // Check if userGroup is provided and exists
    let userGroupRecord: any = null;
    if (userGroup) {
      userGroupRecord = await prisma.userGroup.findUnique({
        where: { name: userGroup },
      });
      if (!userGroupRecord) {
        throw new Error(`UserGroup "${userGroup}" does not exist`);
      }
    }

    // Permission check: Only allow creating users in a group lower than the current user's highest group
    if (userGroup && currentUserGroups && currentUserGroups.length > 0) {
      // Find the highest group of the current user
      const currentUserHighestRank = currentUserGroups
        .map((g) => groupRank.indexOf(g))
        .filter((i) => i !== -1)
        .sort((a, b) => a - b)[0];

      const targetGroupRank = groupRank.indexOf(userGroup);

      if (
        currentUserHighestRank === undefined ||
        currentUserHighestRank === -1 ||
        targetGroupRank === -1
      ) {
        throw new Error('Invalid user group for permission check');
      }

      // Only allow if the target group is lower (higher index) than the current user's highest group
      if (targetGroupRank <= currentUserHighestRank) {
        throw new Error(
          `Insufficient permissions: cannot create user in group "${userGroup}"`
        );
      }
    }

    // If id is provided, use it to find the user (edit mode)
    let existingUser: any = null;
    if (id) {
      existingUser = await prisma.user.findUnique({
        where: { id },
        include: {
          UserGroupUser: {
            include: {
              UserGroup: true,
            },
          },
        },
      });
    } else {
      // Otherwise, find by email (create mode or legacy)
      existingUser = await prisma.user.findUnique({
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

    if (existingUser) {
      // If password is provided, update password and salt, otherwise keep old ones
      let updatePassword = false;
      let hashedPassword = existingUser.password;
      let salt = existingUser.salt;
      if (password) {
        salt = generateSalt();
        hashedPassword = hashPassword(password, salt, CURRENT_ITERATIONS);
        updatePassword = true;
      }

      // Never overwrite companyId when editing a user
      if (updatePassword) {
        await prisma.$executeRaw`
          UPDATE users
          SET password = ${hashedPassword},
              salt = ${salt},
              passwordIterations = ${CURRENT_ITERATIONS},
              displayName = ${displayName},
              email = ${email}
          WHERE id = ${existingUser.id}
        `;
      } else {
        await prisma.$executeRaw`
          UPDATE users
          SET displayName = ${displayName},
              email = ${email}
          WHERE id = ${existingUser.id}
        `;
      }

      // Update phone separately, only when explicitly provided (undefined = leave unchanged)
      if (phone !== undefined) {
        await prisma.user.update({
          where: { id: existingUser.id },
          data: { phone: phone || null },
        });
      }

      // Connect user to userGroup if provided using the helper function
      if (userGroupRecord) {
        await ensureUserInGroup(existingUser.id, userGroup!);
      }

      // Fetch the updated user
      return await prisma.user.findUnique({
        where: { id: existingUser.id },
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
      if (!password) {
        throw new Error('Password is required when creating a new user');
      }
      const salt = generateSalt();
      const hashedPassword = hashPassword(password, salt, CURRENT_ITERATIONS);
      await prisma.$executeRaw`
        INSERT INTO users (userId, email, displayName, phone, hash, password, salt, passwordIterations, marketingEmails, sync, createdAt, updatedAt, companyId, verified)
        VALUES (
          ${userId},
          ${email},
          ${displayName},
          ${phone ?? null},
          ${userHash},
          ${hashedPassword},
          ${salt},
          ${CURRENT_ITERATIONS},
          0,
          0,
          NOW(),
          NOW(),
          ${companyId ?? null},
          1
        )
      `;

      // Fetch the created user
      const createdUser = await prisma.user.findUnique({
        where: { email },
        include: {
          UserGroupUser: {
            include: {
              UserGroup: true,
            },
          },
        },
      });

      // Connect user to userGroup if provided using the helper function
      if (userGroupRecord && createdUser) {
        await ensureUserInGroup(createdUser.id, userGroup!);
      }

      return createdUser;
    }
  } catch (error) {
    console.error('Error creating/updating admin user:', error);
    throw error;
  }
}
