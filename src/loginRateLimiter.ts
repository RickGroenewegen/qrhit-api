import Cache from './cache';

/**
 * Rate limiter for login attempts using Redis-based cache.
 * Tracks failed login attempts per IP+email combination and per IP.
 */
class LoginRateLimiter {
  private static instance: LoginRateLimiter;
  private cache = Cache.getInstance();

  // Rate limit configuration
  private readonly MAX_ATTEMPTS_PER_IP_EMAIL = 5; // Max attempts per IP+email combo
  private readonly MAX_ATTEMPTS_PER_IP = 20; // Max total attempts per IP
  private readonly WINDOW_SECONDS = 900; // 15 minute window
  private readonly LOCKOUT_SECONDS = 1800; // 30 minute lockout

  private constructor() {}

  public static getInstance(): LoginRateLimiter {
    if (!LoginRateLimiter.instance) {
      LoginRateLimiter.instance = new LoginRateLimiter();
    }
    return LoginRateLimiter.instance;
  }

  /**
   * Generate cache key for IP+email combination
   */
  private getIpEmailKey(ip: string, email: string): string {
    const normalizedEmail = email.toLowerCase().trim();
    return `ratelimit:login:ip_email:${ip}:${normalizedEmail}`;
  }

  /**
   * Generate cache key for IP-only tracking
   */
  private getIpKey(ip: string): string {
    return `ratelimit:login:ip:${ip}`;
  }

  /**
   * Generate cache key for lockout status
   */
  private getLockoutKey(ip: string, email: string): string {
    const normalizedEmail = email.toLowerCase().trim();
    return `ratelimit:lockout:${ip}:${normalizedEmail}`;
  }

  /**
   * Check if login attempt is allowed
   * @returns Object with allowed status and retryAfter in seconds if rate limited
   */
  async checkRateLimit(
    ip: string,
    email: string
  ): Promise<{ allowed: boolean; retryAfter?: number }> {
    // Check if currently locked out
    const lockoutKey = this.getLockoutKey(ip, email);
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
    const ipEmailKey = this.getIpEmailKey(ip, email);
    const ipEmailCount = await this.cache.get(ipEmailKey, false);
    if (ipEmailCount && parseInt(ipEmailCount, 10) >= this.MAX_ATTEMPTS_PER_IP_EMAIL) {
      return {
        allowed: false,
        retryAfter: this.LOCKOUT_SECONDS,
      };
    }

    // Check total IP attempt count
    const ipKey = this.getIpKey(ip);
    const ipCount = await this.cache.get(ipKey, false);
    if (ipCount && parseInt(ipCount, 10) >= this.MAX_ATTEMPTS_PER_IP) {
      return {
        allowed: false,
        retryAfter: this.LOCKOUT_SECONDS,
      };
    }

    return { allowed: true };
  }

  /**
   * Record a failed login attempt
   */
  async recordFailedAttempt(ip: string, email: string): Promise<void> {
    const ipEmailKey = this.getIpEmailKey(ip, email);
    const ipKey = this.getIpKey(ip);

    // Increment IP+email counter
    const currentIpEmailCount = await this.cache.get(ipEmailKey, false);
    const newIpEmailCount = currentIpEmailCount
      ? parseInt(currentIpEmailCount, 10) + 1
      : 1;
    await this.cache.set(
      ipEmailKey,
      newIpEmailCount.toString(),
      this.WINDOW_SECONDS
    );

    // Increment IP counter
    const currentIpCount = await this.cache.get(ipKey, false);
    const newIpCount = currentIpCount ? parseInt(currentIpCount, 10) + 1 : 1;
    await this.cache.set(ipKey, newIpCount.toString(), this.WINDOW_SECONDS);

    // If exceeded limits, set lockout
    if (
      newIpEmailCount >= this.MAX_ATTEMPTS_PER_IP_EMAIL ||
      newIpCount >= this.MAX_ATTEMPTS_PER_IP
    ) {
      const lockoutKey = this.getLockoutKey(ip, email);
      const lockoutExpiry = Date.now() + this.LOCKOUT_SECONDS * 1000;
      await this.cache.set(
        lockoutKey,
        lockoutExpiry.toString(),
        this.LOCKOUT_SECONDS
      );
    }
  }

  /**
   * Clear rate limit counters after successful login
   */
  async recordSuccessfulLogin(ip: string, email: string): Promise<void> {
    const ipEmailKey = this.getIpEmailKey(ip, email);
    const lockoutKey = this.getLockoutKey(ip, email);

    // Clear the IP+email counter and lockout
    await this.cache.del(ipEmailKey);
    await this.cache.del(lockoutKey);

    // Note: We don't clear the IP-only counter to prevent
    // attackers from using successful logins to reset limits
  }
}

export default LoginRateLimiter;
