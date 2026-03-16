import PrismaInstance from './prisma';

class AppleStorefront {
  private static instance: AppleStorefront;
  private prisma = PrismaInstance.getInstance();
  private cache: Map<number, string | null> = new Map();

  public static getInstance(): AppleStorefront {
    if (!AppleStorefront.instance) {
      AppleStorefront.instance = new AppleStorefront();
    }
    return AppleStorefront.instance;
  }

  public async getStorefront(phpId: number): Promise<string | null> {
    if (this.cache.has(phpId)) {
      return this.cache.get(phpId)!;
    }

    const result: any[] = await this.prisma.$queryRaw`
      SELECT appleStoreFront FROM payment_has_playlist WHERE id = ${phpId}
    `;

    const sf = result[0]?.appleStoreFront || null;
    this.cache.set(phpId, sf);
    return sf;
  }

  public setStorefront(phpId: number, storefront: string): void {
    this.cache.set(phpId, storefront);
  }
}

export default AppleStorefront;
