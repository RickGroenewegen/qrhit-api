import PrismaInstance from './prisma';
import Logger from './logger';

/**
 * Addresses the AbuseGuard must never ban.
 *
 * This exists for the false positive the detectors cannot rule out from the
 * request alone: a customer whose own deck looks like a scrape. A playlist
 * built entirely from tracks we had never seen gets one contiguous block of
 * track ids, so a customer scanning that deck in printed order produces a
 * genuine ascending run.
 *
 * The table is the source of truth and the guard mirrors it in memory,
 * refreshed on the same interval as the ban list, so an address whitelisted
 * from the dashboard takes effect on every cluster worker within seconds and
 * survives a restart (unlike `QRLINK_DENY_IPS`, which needs a deploy).
 */
class IpAllowlist {
  private static instance: IpAllowlist;
  private prisma = PrismaInstance.getInstance();
  private logger = new Logger();

  private constructor() {}

  public static getInstance(): IpAllowlist {
    if (!IpAllowlist.instance) {
      IpAllowlist.instance = new IpAllowlist();
    }
    return IpAllowlist.instance;
  }

  /** Every allowed address, lower-cased, for the guard's in-memory mirror. */
  public async getAllowedIps(): Promise<string[]> {
    const rows = await this.prisma.allowedIp.findMany({ select: { ip: true } });
    return rows.map((r) => r.ip.toLowerCase());
  }

  /** The full records, newest first, for the admin overview. */
  public async list(): Promise<{
    success: boolean;
    data?: any[];
    error?: string;
  }> {
    try {
      const data = await this.prisma.allowedIp.findMany({
        orderBy: { createdAt: 'desc' },
      });
      return { success: true, data };
    } catch (error) {
      this.logger.log(`Error listing allowed ips: ${error}`);
      return { success: false, error: 'Failed to list allowed ips' };
    }
  }

  public async add(
    ip: string,
    note?: string | null
  ): Promise<{ success: boolean; error?: string }> {
    const cleaned = (ip || '').trim();
    if (!cleaned) {
      return { success: false, error: 'No IP given' };
    }

    try {
      // Whitelisting the same address twice is not an error.
      await this.prisma.allowedIp.upsert({
        where: { ip: cleaned },
        update: { note: note || null },
        create: { ip: cleaned, note: note || null },
      });
      return { success: true };
    } catch (error) {
      this.logger.log(`Error allowing ip ${cleaned}: ${error}`);
      return { success: false, error: 'Failed to allow ip' };
    }
  }

  public async remove(ip: string): Promise<{ success: boolean; error?: string }> {
    const cleaned = (ip || '').trim();
    if (!cleaned) {
      return { success: false, error: 'No IP given' };
    }

    try {
      await this.prisma.allowedIp.deleteMany({ where: { ip: cleaned } });
      return { success: true };
    } catch (error) {
      this.logger.log(`Error removing allowed ip ${cleaned}: ${error}`);
      return { success: false, error: 'Failed to remove allowed ip' };
    }
  }
}

export default IpAllowlist;
