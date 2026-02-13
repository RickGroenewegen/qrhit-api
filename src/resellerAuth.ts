import PrismaInstance from './prisma';
import Cache from './cache';
import Logger from './logger';
import { color, white } from 'console-log-colors';

const prisma = PrismaInstance.getInstance();
const cache = Cache.getInstance();
const logger = new Logger();

const CACHE_TTL = 86400; // 24 hours in seconds
const CACHE_PREFIX = 'reseller_apikey:';

export interface ResellerUser {
  id: number;
  userId: string;
  email: string;
  displayName: string;
}

export async function verifyResellerApiKey(
  request: any,
  reply: any
): Promise<void> {
  const authHeader = request.headers?.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer rk_')) {
    logger.logDev(color.yellow.bold(`[${white.bold('Reseller')}] Auth rejected: missing or invalid API key header`));
    reply.status(401).send({ success: false, error: 'Missing or invalid API key' });
    return;
  }

  const apiKey = authHeader.substring(7); // Strip "Bearer "
  const maskedKey = `${apiKey.substring(0, 6)}...${apiKey.substring(apiKey.length - 4)}`;

  // Check cache first
  const cached = await cache.get(`${CACHE_PREFIX}${apiKey}`, false);
  if (cached) {
    const user = JSON.parse(cached) as ResellerUser;
    logger.logDev(color.blue.bold(`[${white.bold('Reseller')}] Auth cache hit for ${white.bold(maskedKey)} → user ${white.bold(user.id.toString())}`));
    request.resellerUser = user;
    return;
  }

  logger.logDev(color.blue.bold(`[${white.bold('Reseller')}] Auth cache miss for ${white.bold(maskedKey)}, querying DB`));

  // Cache miss - query database
  const user = await prisma.user.findUnique({
    where: { apiKey },
    select: {
      id: true,
      userId: true,
      email: true,
      displayName: true,
      UserGroupUser: {
        select: {
          UserGroup: {
            select: { name: true },
          },
        },
      },
    },
  });

  if (!user) {
    logger.logDev(color.yellow.bold(`[${white.bold('Reseller')}] Auth rejected: no user found for key ${white.bold(maskedKey)}`));
    reply.status(401).send({ success: false, error: 'Invalid API key' });
    return;
  }

  const isApiUser = user.UserGroupUser.some(
    (ug) => ug.UserGroup.name === 'api_users'
  );

  if (!isApiUser) {
    logger.logDev(color.yellow.bold(`[${white.bold('Reseller')}] Auth rejected: user ${white.bold(user.id.toString())} not in api_users group`));
    reply.status(403).send({ success: false, error: 'Forbidden: not an API user' });
    return;
  }

  const resellerUser: ResellerUser = {
    id: user.id,
    userId: user.userId,
    email: user.email,
    displayName: user.displayName,
  };

  // Cache for 24 hours
  await cache.set(`${CACHE_PREFIX}${apiKey}`, JSON.stringify(resellerUser), CACHE_TTL);
  logger.logDev(color.green.bold(`[${white.bold('Reseller')}] Auth success for user ${white.bold(user.id.toString())} (${white.bold(user.displayName)}), cached for 24h`));

  request.resellerUser = resellerUser;
}
