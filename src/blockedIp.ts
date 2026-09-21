import PrismaInstance from './prisma';
import IpAllowlist from './ipAllowlist';
import Logger from './logger';

/**
 * Persists the addresses AbuseGuard refuses, so the admin dashboard can show
 * who was blocked, when and why without anyone having to read the pm2 log.
 *
 * A row is written when a block first takes effect, not per refused request:
 * a blocked scraper keeps hammering (the September 2026 one ran at ~1 req/s)
 * and one row per request would be a write flood, not a record.
 */
class BlockedIp {
  private static instance: BlockedIp;
  private prisma = PrismaInstance.getInstance();
  private logger = new Logger();

  private constructor() {}

  public static getInstance(): BlockedIp {
    if (!BlockedIp.instance) {
      BlockedIp.instance = new BlockedIp();
    }
    return BlockedIp.instance;
  }

  /**
   * Records a block. Never throws: this runs from the request path, and a
   * database problem must not turn into a failed request or an unenforced
   * ban. The caller does not await it.
   */
  public async logBlock(params: {
    ip: string;
    reason: string;
    detail?: string | null;
    userAgent?: string | null;
    php?: number | null;
    trackId?: number | null;
    expiresAt?: Date | null;
  }): Promise<void> {
    const { ip, reason, detail, userAgent, php, trackId, expiresAt } = params;
    if (!ip || !reason) {
      return;
    }

    try {
      // Each cluster worker enforces the ban independently and so reports it
      // independently. Collapse those into one row per address and reason per
      // hour, the way broken links are deduplicated.
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const existing = await this.prisma.blockedIp.findFirst({
        where: { ip, reason, createdAt: { gte: oneHourAgo } },
      });
      if (existing) {
        return;
      }

      await this.prisma.blockedIp.create({
        data: {
          ip,
          reason,
          detail: detail || null,
          userAgent: userAgent || null,
          php: php ?? null,
          trackId: trackId ?? null,
          expiresAt: expiresAt || null,
        },
      });
    } catch (error) {
      this.logger.log(`Error logging blocked ip ${ip}: ${error}`);
    }
  }

  /**
   * Blocked addresses, newest first, for the admin overview.
   */
  public async getBlockedIps(params?: {
    ip?: string;
    reason?: string;
    limit?: number;
    offset?: number;
  }): Promise<{
    success: boolean;
    data?: any[];
    total?: number;
    error?: string;
  }> {
    try {
      const { ip, reason, limit = 50, offset = 0 } = params || {};

      const where: any = {};
      if (ip) {
        where.ip = { contains: ip };
      }
      if (reason) {
        where.reason = reason;
      }

      const [rows, total] = await Promise.all([
        this.prisma.blockedIp.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: limit,
          skip: offset,
        }),
        this.prisma.blockedIp.count({ where }),
      ]);

      const withScan = await this.attachScanContext(rows);
      // Read the whitelist from the table rather than the guard's mirror, so
      // an address whitelisted seconds ago already shows as such.
      const allowed = new Set(await IpAllowlist.getInstance().getAllowedIps());
      const data = withScan.map((r) => ({
        ...r,
        allowed: allowed.has(String(r.ip).toLowerCase()),
      }));

      return { success: true, data, total };
    } catch (error) {
      this.logger.log(`Error fetching blocked ips: ${error}`);
      return { success: false, error: 'Failed to fetch blocked ips' };
    }
  }

  /**
   * Resolves each row's `php` into the order and playlist it belongs to, so
   * the overview can say whose cards were being read rather than showing a
   * bare id. Looked up in one query for the whole page; a row whose order has
   * since been deleted simply keeps `scan: null`.
   */
  private async attachScanContext(rows: any[]): Promise<any[]> {
    const ids = [
      ...new Set(
        rows
          .map((r) => r.php)
          .filter((php): php is number => typeof php === 'number'),
      ),
    ];
    if (ids.length === 0) {
      return rows.map((r) => ({ ...r, scan: null }));
    }

    const links = await this.prisma.paymentHasPlaylist.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        numberOfTracks: true,
        playlist: { select: { id: true, name: true, slug: true } },
        payment: {
          select: {
            id: true,
            paymentId: true,
            orderId: true,
            fullname: true,
            email: true,
            createdAt: true,
          },
        },
      },
    });

    const byId = new Map(links.map((l) => [l.id, l]));
    return rows.map((r) => {
      const link = typeof r.php === 'number' ? byId.get(r.php) : undefined;
      return {
        ...r,
        scan: link
          ? {
              playlistId: link.playlist?.id ?? null,
              playlistName: link.playlist?.name ?? null,
              playlistSlug: link.playlist?.slug ?? null,
              numberOfTracks: link.numberOfTracks,
              paymentId: link.payment?.id ?? null,
              orderId: link.payment?.orderId || link.payment?.paymentId || null,
              customerName: link.payment?.fullname ?? null,
              customerEmail: link.payment?.email ?? null,
              orderedAt: link.payment?.createdAt ?? null,
            }
          : null,
      };
    });
  }

  /**
   * Removes a recorded block. This is bookkeeping only: it does not lift the
   * ban itself, which lives in Redis and expires on its own.
   */
  public async deleteBlockedIp(
    id: number
  ): Promise<{ success: boolean; error?: string }> {
    try {
      await this.prisma.blockedIp.delete({ where: { id } });
      return { success: true };
    } catch (error) {
      this.logger.log(`Error deleting blocked ip ${id}: ${error}`);
      return { success: false, error: 'Failed to delete blocked ip' };
    }
  }
}

export default BlockedIp;
