import Cache from './cache';

export type RateLimitFlow = 'login' | 'pincode' | 'password-reset';

interface FlowConfig {
  maxAttemptsPerIpEmail: number;
  maxAttemptsPerIp: number;
  windowSeconds: number;
  lockoutSeconds: number;
}

const FLOW_CONFIGS: Record<RateLimitFlow, FlowConfig> = {
  login: {
    maxAttemptsPerIpEmail: 10,
    maxAttemptsPerIp: 50,
    windowSeconds: 900, // 15 minute window
    lockoutSeconds: 600, // 10 minute lockout
  },
  pincode: {
    maxAttemptsPerIpEmail: 10,
    maxAttemptsPerIp: 30,
    windowSeconds: 900,
    lockoutSeconds: 600,
  },
  'password-reset': {
    maxAttemptsPerIpEmail: 5,
    maxAttemptsPerIp: 15,
    windowSeconds: 900,
    lockoutSeconds: 900,
  },
};

/**
 * Rate limiter for account actions using Redis-based cache.
 * Supports separate limits for login, pincode, and password-reset flows.
 */
class LoginRateLimiter {
  private static instance: LoginRateLimiter;
  private cache = Cache.getInstance();

  private constructor() {}

  public static getInstance(): LoginRateLimiter {
    if (!LoginRateLimiter.instance) {
      LoginRateLimiter.instance = new LoginRateLimiter();
    }
    return LoginRateLimiter.instance;
  }

  private getIpEmailKey(flow: RateLimitFlow, ip: string, email: string): string {
    const normalizedEmail = email.toLowerCase().trim();
    return `ratelimit:${flow}:ip_email:${ip}:${normalizedEmail}`;
  }

  private getIpKey(flow: RateLimitFlow, ip: string): string {
    return `ratelimit:${flow}:ip:${ip}`;
  }

  private getLockoutKey(flow: RateLimitFlow, ip: string, email: string): string {
    const normalizedEmail = email.toLowerCase().trim();
    return `ratelimit:${flow}:lockout:${ip}:${normalizedEmail}`;
  }

  /**
   * Check if an attempt is allowed for the given flow.
   */
  async checkRateLimit(
    ip: string,
    email: string,
    flow: RateLimitFlow = 'login'
  ): Promise<{ allowed: boolean; retryAfter?: number }> {
    const config = FLOW_CONFIGS[flow];

    // Check if currently locked out
    const lockoutKey = this.getLockoutKey(flow, ip, email);
    const lockoutExpiry = await this.cache.get(lockoutKey, false);
    if (lockoutExpiry) {
      const expiryTime = parseInt(lockoutExpiry, 10);
      const now = Date.now();
      if (expiryTime > now) {
        return {
          allowed: false,
          retryAfter: Math.ceil((expiryTime - now) / 1000),
        };
      }
    }

    // Check IP+email attempt count
    const ipEmailKey = this.getIpEmailKey(flow, ip, email);
    const ipEmailCount = await this.cache.get(ipEmailKey, false);
    if (ipEmailCount && parseInt(ipEmailCount, 10) >= config.maxAttemptsPerIpEmail) {
      return {
        allowed: false,
        retryAfter: config.lockoutSeconds,
      };
    }

    // Check total IP attempt count
    const ipKey = this.getIpKey(flow, ip);
    const ipCount = await this.cache.get(ipKey, false);
    if (ipCount && parseInt(ipCount, 10) >= config.maxAttemptsPerIp) {
      return {
        allowed: false,
        retryAfter: config.lockoutSeconds,
      };
    }

    return { allowed: true };
  }

  /**
   * Record a failed attempt for the given flow.
   */
  async recordFailedAttempt(
    ip: string,
    email: string,
    flow: RateLimitFlow = 'login'
  ): Promise<void> {
    const config = FLOW_CONFIGS[flow];
    const ipEmailKey = this.getIpEmailKey(flow, ip, email);
    const ipKey = this.getIpKey(flow, ip);

    // Increment IP+email counter
    const currentIpEmailCount = await this.cache.get(ipEmailKey, false);
    const newIpEmailCount = currentIpEmailCount
      ? parseInt(currentIpEmailCount, 10) + 1
      : 1;
    await this.cache.set(
      ipEmailKey,
      newIpEmailCount.toString(),
      config.windowSeconds
    );

    // Increment IP counter
    const currentIpCount = await this.cache.get(ipKey, false);
    const newIpCount = currentIpCount ? parseInt(currentIpCount, 10) + 1 : 1;
    await this.cache.set(ipKey, newIpCount.toString(), config.windowSeconds);

    // If exceeded limits, set lockout
    if (
      newIpEmailCount >= config.maxAttemptsPerIpEmail ||
      newIpCount >= config.maxAttemptsPerIp
    ) {
      const lockoutKey = this.getLockoutKey(flow, ip, email);
      const lockoutExpiry = Date.now() + config.lockoutSeconds * 1000;
      await this.cache.set(
        lockoutKey,
        lockoutExpiry.toString(),
        config.lockoutSeconds
      );
    }
  }

  /**
   * Clear rate limit counters after successful action.
   */
  async recordSuccessfulLogin(
    ip: string,
    email: string,
    flow: RateLimitFlow = 'login'
  ): Promise<void> {
    const ipEmailKey = this.getIpEmailKey(flow, ip, email);
    const lockoutKey = this.getLockoutKey(flow, ip, email);
    const ipKey = this.getIpKey(flow, ip);

    await this.cache.del(ipEmailKey);
    await this.cache.del(lockoutKey);
    await this.cache.del(ipKey);
  }
}

export default LoginRateLimiter;
