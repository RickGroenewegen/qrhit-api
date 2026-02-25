import PrintEnBind from './printers/printenbind';

interface PrinterCostInput {
  avgCards?: number;
  acquisitionMode?: 'buy' | 'lease';
  equipmentCost?: number;
  leaseMonthlyPayment?: number;
  leaseDeposit?: number;
  ordersPerMonth?: number;
  externalCardPrice?: number;
  externalHandling?: number;
  externalShipping?: number;
  paperPricePerSheet?: number;
  cardsPerSheet?: number;
  printCostPer175?: number;
  ownShippingCost?: number;
  envelopePrice?: number;
  thermicLabelPrice?: number;
  cuttingMachineMonthlyCost?: number;
}

interface PrinterCostResult {
  acquisitionMode: string;
  consumerPrice: {
    priceInclTax: number;
    priceExclTax: number;
    pricePerCard: number;
    marginExternal: number;
    marginOwn: number;
    marginExternalPercentage: number;
    marginOwnPercentage: number;
  };
  external: {
    cardPrice: number;
    handling: number;
    shipping: number;
    totalPerOrder: number;
    costPerCard: number;
  };
  own: {
    paperCost: number;
    printCost: number;
    shippingCost: number;
    envelopePrice: number;
    thermicLabelPrice: number;
    cuttingMachineMonthlyCost: number;
    totalPerOrder: number;
    costPerCard: number;
  };
  savings: {
    perOrder: number;
    perMonth: number;
    percentage: number;
  };
  breakeven: {
    orders: number;
    months: number;
    years: number;
  };
  projections: {
    yearOne: number;
    yearTwo: number;
    fiveYear: number;
  };
  chartData: {
    months: number[];
    externalCosts: number[];
    ownCosts: number[];
    cumulativeSavings: number[];
  };
}

class Printer {
  private static instance: Printer;

  private readonly defaults = {
    avgCards: 200,
    acquisitionMode: 'buy' as const,
    equipmentCost: 45000,
    leaseMonthlyPayment: 900,
    leaseDeposit: 0,
    ordersPerMonth: 350,
    externalCardPrice: 14.0,
    externalHandling: 1.8,
    externalShipping: 3.45,
    paperPricePerSheet: 0.26,
    cardsPerSheet: 18,
    printCostPer175: 3.5,
    ownShippingCost: 3.45,
    envelopePrice: 0.2,
    thermicLabelPrice: 0.01,
    cuttingMachineMonthlyCost: 120,
  };

  private constructor() {}

  public static getInstance(): Printer {
    if (!Printer.instance) {
      Printer.instance = new Printer();
    }
    return Printer.instance;
  }

  getDefaults() {
    return { ...this.defaults };
  }

  async calculate(input: PrinterCostInput) {
    const d = this.defaults;
    const avgCards = input.avgCards ?? d.avgCards;
    const acquisitionMode = input.acquisitionMode ?? d.acquisitionMode;
    const equipmentCost = input.equipmentCost ?? d.equipmentCost;
    const leaseMonthlyPayment = input.leaseMonthlyPayment ?? d.leaseMonthlyPayment;
    const leaseDeposit = input.leaseDeposit ?? d.leaseDeposit;
    const ordersPerMonth = input.ordersPerMonth ?? d.ordersPerMonth;
    const externalCardPrice = input.externalCardPrice ?? d.externalCardPrice;
    const externalHandling = input.externalHandling ?? d.externalHandling;
    const externalShipping = input.externalShipping ?? d.externalShipping;
    const paperPricePerSheet = input.paperPricePerSheet ?? d.paperPricePerSheet;
    const cardsPerSheet = input.cardsPerSheet ?? d.cardsPerSheet;
    const printCostPer175 = input.printCostPer175 ?? d.printCostPer175;
    const ownShippingCost = input.ownShippingCost ?? d.ownShippingCost;
    const envelopePrice = input.envelopePrice ?? d.envelopePrice;
    const thermicLabelPrice = input.thermicLabelPrice ?? d.thermicLabelPrice;
    const cuttingMachineMonthlyCost = input.cuttingMachineMonthlyCost ?? d.cuttingMachineMonthlyCost;

    const isLease = acquisitionMode === 'lease';

    // External printer costs (cardPrice is per 200 cards, scale proportionally)
    const externalCardPriceScaled = (avgCards / 200) * externalCardPrice;
    const externalTotalPerOrder = externalCardPriceScaled + externalHandling + externalShipping;
    const externalCostPerCard = externalTotalPerOrder / avgCards;

    // Own production costs (variable per order)
    const sheetsNeeded = Math.ceil(avgCards / cardsPerSheet);
    const ownPaperCost = sheetsNeeded * paperPricePerSheet;
    const ownPrintCost = (avgCards / 175) * printCostPer175;
    const ownTotalPerOrder = ownPaperCost + ownPrintCost + ownShippingCost + envelopePrice + thermicLabelPrice;
    const ownCostPerCard = ownTotalPerOrder / avgCards;

    // Monthly fixed costs differ by mode
    const monthlyFixedCosts = isLease
      ? cuttingMachineMonthlyCost + leaseMonthlyPayment
      : cuttingMachineMonthlyCost;

    // Upfront cost differs by mode
    const upfrontCost = isLease ? leaseDeposit : equipmentCost;

    // Savings
    const savingsPerOrder = externalTotalPerOrder - ownTotalPerOrder;
    const savingsPerMonth = (savingsPerOrder * ordersPerMonth) - monthlyFixedCosts;
    const savingsPercentage = externalTotalPerOrder > 0
      ? (savingsPerOrder / externalTotalPerOrder) * 100
      : 0;

    // Break-even
    const breakEvenMonths = savingsPerMonth > 0 && upfrontCost > 0
      ? upfrontCost / savingsPerMonth
      : savingsPerMonth > 0 && upfrontCost === 0
        ? 0
        : Infinity;
    const breakEvenOrders = isFinite(breakEvenMonths)
      ? Math.ceil(breakEvenMonths * ordersPerMonth)
      : Infinity;
    const breakEvenYears = breakEvenMonths / 12;

    // Projections
    const yearOneSavings = (savingsPerMonth * 12) - upfrontCost;
    const yearTwoSavings = (savingsPerMonth * 24) - upfrontCost;
    const fiveYearSavings = (savingsPerMonth * 60) - upfrontCost;

    // Chart data - extend to cover break-even + 20% buffer, min 36 months
    const maxMonths = isFinite(breakEvenMonths) && breakEvenMonths > 0
      ? Math.max(36, Math.ceil(breakEvenMonths * 1.2))
      : 60;
    const months: number[] = [];
    const externalCosts: number[] = [];
    const ownCosts: number[] = [];
    const cumulativeSavings: number[] = [];

    for (let m = 0; m <= maxMonths; m++) {
      months.push(m);
      externalCosts.push(Math.round(externalTotalPerOrder * ordersPerMonth * m * 100) / 100);
      ownCosts.push(Math.round((upfrontCost + ownTotalPerOrder * ordersPerMonth * m + monthlyFixedCosts * m) * 100) / 100);
      cumulativeSavings.push(Math.round((savingsPerMonth * m - upfrontCost) * 100) / 100);
    }

    // Consumer price - what the customer currently pays
    const printEnBind = PrintEnBind.getInstance();
    const consumerCalc = await printEnBind.calculateSingleItem({
      productType: 'cards',
      type: 'physical',
      subType: 'none',
      quantity: avgCards,
      alternatives: {},
    }, false);
    const consumerPriceInclTax = consumerCalc.price;
    const consumerPriceExclTax = Math.round((consumerPriceInclTax / 1.21) * 100) / 100;
    const consumerPricePerCard = Math.round((consumerPriceExclTax / avgCards) * 10000) / 10000;
    const marginExternal = Math.round((consumerPriceExclTax - externalTotalPerOrder) * 100) / 100;
    const marginOwn = Math.round((consumerPriceExclTax - ownTotalPerOrder) * 100) / 100;
    const marginExternalPercentage = consumerPriceExclTax > 0
      ? Math.round((marginExternal / consumerPriceExclTax) * 10000) / 100
      : 0;
    const marginOwnPercentage = consumerPriceExclTax > 0
      ? Math.round((marginOwn / consumerPriceExclTax) * 10000) / 100
      : 0;

    const inputs = {
      avgCards,
      acquisitionMode: acquisitionMode as 'buy' | 'lease',
      equipmentCost,
      leaseMonthlyPayment,
      leaseDeposit,
      ordersPerMonth,
      externalCardPrice,
      externalHandling,
      externalShipping,
      paperPricePerSheet,
      cardsPerSheet,
      printCostPer175,
      ownShippingCost,
      envelopePrice,
      thermicLabelPrice,
      cuttingMachineMonthlyCost,
    };

    const result: PrinterCostResult = {
      acquisitionMode,
      consumerPrice: {
        priceInclTax: consumerPriceInclTax,
        priceExclTax: consumerPriceExclTax,
        pricePerCard: consumerPricePerCard,
        marginExternal,
        marginOwn,
        marginExternalPercentage,
        marginOwnPercentage,
      },
      external: {
        cardPrice: Math.round(externalCardPriceScaled * 100) / 100,
        handling: externalHandling,
        shipping: externalShipping,
        totalPerOrder: Math.round(externalTotalPerOrder * 100) / 100,
        costPerCard: Math.round(externalCostPerCard * 10000) / 10000,
      },
      own: {
        paperCost: Math.round(ownPaperCost * 100) / 100,
        printCost: Math.round(ownPrintCost * 100) / 100,
        shippingCost: ownShippingCost,
        envelopePrice,
        thermicLabelPrice,
        cuttingMachineMonthlyCost,
        totalPerOrder: Math.round(ownTotalPerOrder * 100) / 100,
        costPerCard: Math.round(ownCostPerCard * 10000) / 10000,
      },
      savings: {
        perOrder: Math.round(savingsPerOrder * 100) / 100,
        perMonth: Math.round(savingsPerMonth * 100) / 100,
        percentage: Math.round(savingsPercentage * 100) / 100,
      },
      breakeven: {
        orders: breakEvenOrders,
        months: Math.round(breakEvenMonths * 100) / 100,
        years: Math.round(breakEvenYears * 100) / 100,
      },
      projections: {
        yearOne: Math.round(yearOneSavings * 100) / 100,
        yearTwo: Math.round(yearTwoSavings * 100) / 100,
        fiveYear: Math.round(fiveYearSavings * 100) / 100,
      },
      chartData: {
        months,
        externalCosts,
        ownCosts,
        cumulativeSavings,
      },
    };

    return { inputs, result };
  }
}

export default Printer;
