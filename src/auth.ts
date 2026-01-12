import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import Utils from './utils';
import Mail from './mail';
import PrismaInstance from './prisma';

const prisma = PrismaInstance.getInstance();
const utils = new Utils();
const mail = Mail.getInstance();

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

/**
 * Validates password strength
 * @param password The password to validate
 * @returns Object with isValid boolean and error message if invalid
 */
function validatePassword(password: string): {
  isValid: boolean;
  error?: string;
} {
  if (password.length < 8) {
    return {
      isValid: false,
      error: 'passwordTooShort',
    };
  }

  if (!/[A-Z]/.test(password)) {
    return {
      isValid: false,
      error: 'passwordNeedsUppercase',
    };
  }

  if (!/[a-z]/.test(password)) {
    return {
      isValid: false,
      error: 'passwordNeedsLowercase',
    };
  }

  if (!/[0-9]/.test(password)) {
    return {
      isValid: false,
      error: 'passwordNeedsNumber',
    };
  }

  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
    return {
      isValid: false,
      error: 'passwordNeedsSpecialCharacter',
    };
  }

  return { isValid: true };
}

/**
 * Verifies a user account using verification hash
 * @param verificationHash The verification hash from the email
 * @returns Object with success status, auth token, and user info or error
 */
export async function verifyUser(verificationHash: string): Promise<{
  success: boolean;
  token?: string;
  userId?: string;
  userGroups?: string[];
  companyId?: number;
  message?: string;
  error?: string;
}> {
  try {
    // Validate required field
    if (!verificationHash) {
      return {
        success: false,
        error: 'hashIsRequired',
      };
    }

    // Find user with this verification hash
    const user = await prisma.user.findUnique({
      where: { verificationHash },
      include: {
        UserGroupUser: {
          include: {
            UserGroup: true,
          },
        },
      },
    });

    if (!user) {
      return {
        success: false,
        error: 'invalidHash',
      };
    }

    // Check if user is already verified
    if (user.verified) {
      return {
        success: false,
        error: 'alreadyVerified',
      };
    }

    // Verify the user account
    await prisma.user.update({
      where: { id: user.id },
      data: {
        verified: true,
        verifiedAt: new Date(),
        verificationHash: null, // Clear the verification hash
      },
    });

    // Extract user group names
    const userGroups = user.UserGroupUser.map((ugu) => ugu.UserGroup.name);

    // Generate auth token
    const token = generateToken(
      user.userId,
      userGroups,
      user.companyId || undefined
    );

    return {
      success: true,
      token,
      userId: user.userId,
      userGroups: userGroups,
      companyId: user.companyId || undefined,
      message: 'verificationSuccess',
    };
  } catch (error) {
    console.error('Error in account verification:', error);
    return {
      success: false,
      error: 'serverError',
    };
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
 * Resets a user's password using a reset token
 * @param resetToken The password reset token
 * @param password1 The new password
 * @param password2 The password confirmation
 * @param captchaToken The reCAPTCHA token for verification
 * @returns Object with success status and message or error
 */
export async function resetPassword(
  resetToken: string,
  password1: string,
  password2: string,
  captchaToken: string
): Promise<{
  success: boolean;
  message?: string;
  error?: string;
}> {
  try {
    // Validate required fields
    if (!resetToken || !password1 || !password2 || !captchaToken) {
      return {
        success: false,
        error: 'missingRequiredFields',
      };
    }

    // Verify captcha
    const isHuman = await utils.verifyRecaptcha(captchaToken);
    if (!isHuman) {
      return {
        success: false,
        error: 'captchaVerificationFailed',
      };
    }

    // Check if passwords match
    if (password1 !== password2) {
      return {
        success: false,
        error: 'passwordsDoNotMatch',
      };
    }

    // Validate password strength
    const passwordValidation = validatePassword(password1);
    if (!passwordValidation.isValid) {
      return {
        success: false,
        error: passwordValidation.error,
      };
    }

    // Find user with this reset token
    const user = await prisma.user.findUnique({
      where: { passwordResetToken: resetToken },
    });

    if (!user) {
      return {
        success: false,
        error: 'invalidOrExpiredToken',
      };
    }

    // Check if token has expired
    if (!user.passwordResetExpiry || user.passwordResetExpiry < new Date()) {
      return {
        success: false,
        error: 'invalidOrExpiredToken',
      };
    }

    // Generate new password hash
    const salt = generateSalt();
    const hashedPassword = hashPassword(password1, salt);

    // Update user's password and clear reset token
    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashedPassword,
        salt: salt,
        passwordResetToken: null,
        passwordResetExpiry: null,
      },
    });

    return {
      success: true,
      message: 'passwordResetSuccess',
    };
  } catch (error) {
    console.error('Error in password reset:', error);
    return {
      success: false,
      error: 'internalServerError',
    };
  }
}

/**
 * Checks if a password reset token is valid and not expired
 * @param resetToken The password reset token to check
 * @returns Object with valid boolean
 */
export async function checkPasswordResetToken(resetToken: string): Promise<{
  valid: boolean;
}> {
  try {
    if (!resetToken) {
      return { valid: false };
    }

    // Find user with this reset token
    const user = await prisma.user.findUnique({
      where: { passwordResetToken: resetToken },
    });

    if (!user) {
      return { valid: false };
    }

    // Check if token has expired
    if (!user.passwordResetExpiry || user.passwordResetExpiry < new Date()) {
      return { valid: false };
    }

    return { valid: true };
  } catch (error) {
    console.error('Error checking password reset token:', error);
    return { valid: false };
  }
}

/**
 * Initiates password reset process by sending reset email
 * @param email The user's email address
 * @param captchaToken The reCAPTCHA token for verification
 * @returns Object with success status and message or error
 */
export async function initiatePasswordReset(
  email: string,
  captchaToken: string
): Promise<{
  success: boolean;
  message?: string;
  error?: string;
}> {
  try {
    // Validate required fields
    if (!email || !captchaToken) {
      return {
        success: false,
        error: 'missingRequiredFields',
      };
    }

    // Verify captcha
    const isHuman = await utils.verifyRecaptcha(captchaToken);
    if (!isHuman) {
      return {
        success: false,
        error: 'captchaVerificationFailed',
      };
    }

    // Validate email format
    if (!utils.isValidEmail(email)) {
      return {
        success: false,
        error: 'invalidEmailFormat',
      };
    }

    // Find user by email
    const user = await prisma.user.findUnique({
      where: { email },
    });

    // Always return success to prevent email enumeration attacks
    // But only send email if user exists and is verified
    if (user && user.verified) {
      // Generate reset token
      const resetToken = crypto.randomBytes(32).toString('hex');
      const resetTokenExpiry = new Date(Date.now() + 3600000); // 1 hour from now

      // Store reset token in database
      await prisma.user.update({
        where: { id: user.id },
        data: {
          passwordResetToken: resetToken,
          passwordResetExpiry: resetTokenExpiry,
        },
      });

      // Send password reset email
      await mail.sendPasswordResetMail(
        email,
        user.displayName,
        resetToken,
        user.locale || 'en'
      );
    }

    return {
      success: true,
      message: 'passwordResetEmailSent',
    };
  } catch (error) {
    console.error('Error in password reset initiation:', error);
    return {
      success: false,
      error: 'internalServerError',
    };
  }
}

/**
 * Registers a new user account or upgrades an existing unverified account
 * @param displayName The user's display name
 * @param email The user's email address
 * @param password1 The password
 * @param password2 The password confirmation
 * @param captchaToken The reCAPTCHA token for verification
 * @param locale The user's language code
 * @returns Object with success status and message or error
 */
export async function registerAccount(
  displayName: string,
  email: string,
  password1: string,
  password2: string,
  captchaToken: string,
  locale?: string
): Promise<{
  success: boolean;
  message?: string;
  error?: string;
}> {
  try {
    // Validate required fields
    if (!displayName || !email || !password1 || !password2 || !captchaToken) {
      return {
        success: false,
        error: 'missingRequiredFields',
      };
    }

    // Default locale to 'en' if not provided
    const userLocale = locale || 'en';

    // Verify captcha
    const isHuman = await utils.verifyRecaptcha(captchaToken);
    if (!isHuman) {
      return {
        success: false,
        error: 'captchaVerificationFailed',
      };
    }

    // Validate email format
    if (!utils.isValidEmail(email)) {
      return {
        success: false,
        error: 'invalidEmailFormat',
      };
    }

    // Check if passwords match
    if (password1 !== password2) {
      return {
        success: false,
        error: 'passwordsDoNotMatch',
      };
    }

    // Validate password strength
    const passwordValidation = validatePassword(password1);
    if (!passwordValidation.isValid) {
      return {
        success: false,
        error: passwordValidation.error,
      };
    }

    // Check if user already exists
    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      if (existingUser.upgraded) {
        // User already upgraded, send verification email and return duplicate account error
        try {
          await mail.sendQRSongVerificationMail(
            email,
            displayName,
            '', // No verification hash needed for existing users
            userLocale
          );
        } catch (emailError) {
          console.error(
            'Error sending verification email to existing user:',
            emailError
          );
          // Continue with the error response even if email fails
        }

        return {
          success: false,
          error: 'accountAlreadyExists',
        };
      } else {
        // User exists but not upgraded, update the user
        const salt = generateSalt();
        const hashedPassword = hashPassword(password1, salt);
        const verificationHash = crypto.randomBytes(16).toString('hex');

        const updatedUser = await prisma.user.update({
          where: { email },
          data: {
            displayName,
            password: hashedPassword,
            salt,
            upgraded: true,
            locale: userLocale,
            verified: false,
            verificationHash: verificationHash,
            verifiedAt: null,
          },
        });

        // Ensure user is connected to 'users' usergroup
        await ensureUserInGroup(updatedUser.id, 'users');

        // Send verification email
        await mail.sendQRSongVerificationMail(
          email,
          displayName,
          verificationHash,
          userLocale
        );

        return {
          success: true,
          message: 'accountUpgraded',
        };
      }
    } else {
      // Create new user with verification hash
      const salt = generateSalt();
      const hashedPassword = hashPassword(password1, salt);
      const userHash = crypto.randomBytes(16).toString('hex');
      const verificationHash = crypto.randomBytes(16).toString('hex');

      const newUser = await prisma.user.create({
        data: {
          userId: email,
          email,
          displayName,
          password: hashedPassword,
          salt,
          hash: userHash,
          locale: userLocale,
          marketingEmails: false,
          sync: false,
          upgraded: true,
          verified: false,
          verificationHash: verificationHash,
          verifiedAt: null,
        },
      });

      // Ensure user is connected to 'users' usergroup
      await ensureUserInGroup(newUser.id, 'users');

      // Send verification email
      await mail.sendQRSongVerificationMail(
        email,
        displayName,
        verificationHash,
        userLocale
      );

      return {
        success: true,
        message: 'accountCreated',
      };
    }
  } catch (error) {
    console.error('Error in account registration:', error);
    return {
      success: false,
      error: 'internalServerError',
    };
  }
}

export async function createOrUpdateAdminUser(
  email: string,
  password: string,
  displayName: string,
  companyId?: number,
  userGroup?: string,
  id?: number,
  currentUserGroups?: string[] // Pass the current user's groups for permission check
): Promise<any> {
  const userId = email;
  const userHash = crypto.randomBytes(16).toString('hex');
  // The order of this array defines the hierarchy: first is highest
  const groupRank = ['admin', 'vibeadmin', 'companyadmin'];

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
        hashedPassword = hashPassword(password, salt);
        updatePassword = true;
      }

      // Never overwrite companyId when editing a user
      if (updatePassword) {
        await prisma.$executeRaw`
          UPDATE users 
          SET password = ${hashedPassword}, 
              salt = ${salt}, 
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
      const hashedPassword = hashPassword(password, salt);
      await prisma.$executeRaw`
        INSERT INTO users (userId, email, displayName, hash, password, salt, marketingEmails, sync, createdAt, updatedAt, companyId, verified)
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
