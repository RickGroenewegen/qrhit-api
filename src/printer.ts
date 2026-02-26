import PrintEnBind from './printers/printenbind';

interface PrinterCostInput {
  avgCards?: number;
  acquisitionMode?: 'buy' | 'lease';
  equipmentCost?: number;
  leaseMonthlyPayment?: number;
  leaseDurationMonths?: number;
  leaseDeposit?: number;
  ordersPerMonth?: number;
  externalCardPrice?: number;
  externalHandling?: number;
  externalShipping?: number;
  paperPricePerSheet?: number;
  cardsPerSheet?: number;
  printCostPerSheet?: number;
  docucutterPartsPerSheet?: number;
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
    perSheet: {
      paper: number;
      printClicks: number;
      docucutterService: number;
      docucutterParts: number;
      depreciation: number;
      total: number;
    };
    paperCost: number;
    printCost: number;
    docucutterServiceCost: number;
    docucutterPartsCost: number;
    depreciationCost: number;
    shippingCost: number;
    envelopePrice: number;
    thermicLabelPrice: number;
    variablePerOrder: number;
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
    leaseDurationMonths: 60,
    leaseDeposit: 0,
    ordersPerMonth: 350,
    externalCardPrice: 14.0,
    externalHandling: 1.8,
    externalShipping: 3.45,
    paperPricePerSheet: 0.145,
    cardsPerSheet: 18,
    printCostPerSheet: 0.197,
    docucutterPartsPerSheet: 0.020,
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
    const leaseDurationMonths = input.leaseDurationMonths ?? d.leaseDurationMonths;
    const leaseDeposit = input.leaseDeposit ?? d.leaseDeposit;
    const ordersPerMonth = input.ordersPerMonth ?? d.ordersPerMonth;
    const externalCardPrice = input.externalCardPrice ?? d.externalCardPrice;
    const externalHandling = input.externalHandling ?? d.externalHandling;
    const externalShipping = input.externalShipping ?? d.externalShipping;
    const paperPricePerSheet = input.paperPricePerSheet ?? d.paperPricePerSheet;
    const cardsPerSheet = input.cardsPerSheet ?? d.cardsPerSheet;
    const printCostPerSheet = input.printCostPerSheet ?? d.printCostPerSheet;
    const docucutterPartsPerSheet = input.docucutterPartsPerSheet ?? d.docucutterPartsPerSheet;
    const ownShippingCost = input.ownShippingCost ?? d.ownShippingCost;
    const envelopePrice = input.envelopePrice ?? d.envelopePrice;
    const thermicLabelPrice = input.thermicLabelPrice ?? d.thermicLabelPrice;
    const cuttingMachineMonthlyCost = input.cuttingMachineMonthlyCost ?? d.cuttingMachineMonthlyCost;

    const isLease = acquisitionMode === 'lease';

    // External printer costs (cardPrice is per 200 cards, scale proportionally)
    const externalCardPriceScaled = (avgCards / 200) * externalCardPrice;
    const externalTotalPerOrder = externalCardPriceScaled + externalHandling + externalShipping;
    const externalCostPerCard = externalTotalPerOrder / avgCards;

    // Own production costs
    const sheetsNeeded = Math.ceil(avgCards / cardsPerSheet);
    const monthlyCardVolume = ordersPerMonth * avgCards;

    // Per-sheet cost breakdown (for all-in display, matching cost specification)
    const perSheetPaper = paperPricePerSheet;
    const perSheetPrintClicks = printCostPerSheet;
    const perSheetDocucutterParts = docucutterPartsPerSheet;

    // Distributed costs: monthly cost / card volume * cards per sheet (consistent card-volume basis)
    const perSheetDocucutterService = monthlyCardVolume > 0
      ? (cuttingMachineMonthlyCost / monthlyCardVolume) * cardsPerSheet : 0;
    // Lease: monthly payment + deposit spread over lease duration. Buy: equipment over 5 years.
    const leaseMonthlyEquivalent = leaseMonthlyPayment + (leaseDurationMonths > 0 ? leaseDeposit / leaseDurationMonths : 0);
    const perSheetDepreciation = isLease
      ? (monthlyCardVolume > 0 ? (leaseMonthlyEquivalent / monthlyCardVolume) * cardsPerSheet : 0)
      : (monthlyCardVolume > 0 ? (equipmentCost / (5 * 12 * monthlyCardVolume)) * cardsPerSheet : 0);

    const perSheetTotal = perSheetPaper + perSheetPrintClicks
      + perSheetDocucutterService + perSheetDocucutterParts + perSheetDepreciation;

    // All-in cost per card (production only, for display)
    const allInCostPerCard = cardsPerSheet > 0 ? perSheetTotal / cardsPerSheet : 0;

    // --- Variable costs per order (for break-even / savings - NO distributed costs) ---
    const ownPaperCost = sheetsNeeded * paperPricePerSheet;
    const ownPrintCost = sheetsNeeded * printCostPerSheet;
    const ownDocucutterPartsCost = sheetsNeeded * docucutterPartsPerSheet;
    const ownVariablePerOrder = ownPaperCost + ownPrintCost + ownDocucutterPartsCost
      + ownShippingCost + envelopePrice + thermicLabelPrice;

    // --- Distributed costs per order (for display only) ---
    const ownDocucutterServiceCost = sheetsNeeded * perSheetDocucutterService;
    const ownDepreciationCost = sheetsNeeded * perSheetDepreciation;

    // All-in per order (for display - includes everything)
    const ownTotalPerOrder = ownVariablePerOrder + ownDocucutterServiceCost + ownDepreciationCost;

    // --- Upfront cost (for break-even - NOT in per-order variable) ---
    const upfrontCost = isLease ? leaseDeposit : equipmentCost;

    // Savings (variable costs only - no double counting)
    const savingsPerOrder = externalTotalPerOrder - ownVariablePerOrder;
    const grossSavingsPerMonth = savingsPerOrder * ordersPerMonth;

    // Month-aware fixed costs (lease payments stop after lease duration)
    const savingsPerMonthDuringLease = grossSavingsPerMonth - cuttingMachineMonthlyCost - leaseMonthlyPayment;
    const savingsPerMonthAfterLease = grossSavingsPerMonth - cuttingMachineMonthlyCost;
    const savingsPerMonth = isLease ? savingsPerMonthDuringLease : savingsPerMonthAfterLease;

    const savingsPercentage = externalTotalPerOrder > 0
      ? (savingsPerOrder / externalTotalPerOrder) * 100
      : 0;

    // Cumulative savings helper (lease-duration aware)
    const cumulativeSavingsAtMonth = (m: number): number => {
      const totalFixed = isLease
        ? cuttingMachineMonthlyCost * m + leaseMonthlyPayment * Math.min(m, leaseDurationMonths)
        : cuttingMachineMonthlyCost * m;
      return grossSavingsPerMonth * m - totalFixed - upfrontCost;
    };

    // Break-even
    let breakEvenMonths: number;
    if (!isLease) {
      // Buy mode: simple linear break-even
      breakEvenMonths = savingsPerMonth > 0 && upfrontCost > 0
        ? upfrontCost / savingsPerMonth
        : savingsPerMonth > 0 && upfrontCost === 0 ? 0 : Infinity;
    } else {
      // Lease mode: break-even may happen during or after lease
      if (upfrontCost === 0 && savingsPerMonthDuringLease > 0) {
        breakEvenMonths = 0;
      } else if (savingsPerMonthDuringLease > 0) {
        const duringLeaseBE = upfrontCost / savingsPerMonthDuringLease;
        if (duringLeaseBE <= leaseDurationMonths) {
          breakEvenMonths = duringLeaseBE;
        } else {
          // Doesn't break even during lease, check after
          const cumulativeAtLeaseEnd = cumulativeSavingsAtMonth(leaseDurationMonths);
          if (cumulativeAtLeaseEnd >= 0) {
            breakEvenMonths = leaseDurationMonths;
          } else if (savingsPerMonthAfterLease > 0) {
            breakEvenMonths = leaseDurationMonths + (-cumulativeAtLeaseEnd) / savingsPerMonthAfterLease;
          } else {
            breakEvenMonths = Infinity;
          }
        }
      } else {
        // Losing money during lease, check if post-lease savings recover
        const cumulativeAtLeaseEnd = cumulativeSavingsAtMonth(leaseDurationMonths);
        if (cumulativeAtLeaseEnd >= 0) {
          // Somehow recovered at lease end (edge case)
          breakEvenMonths = leaseDurationMonths;
        } else if (savingsPerMonthAfterLease > 0) {
          breakEvenMonths = leaseDurationMonths + (-cumulativeAtLeaseEnd) / savingsPerMonthAfterLease;
        } else {
          breakEvenMonths = Infinity;
        }
      }
    }

    const breakEvenOrders = isFinite(breakEvenMonths)
      ? Math.ceil(breakEvenMonths * ordersPerMonth)
      : Infinity;
    const breakEvenYears = breakEvenMonths / 12;

    // Projections (month-aware)
    const yearOneSavings = cumulativeSavingsAtMonth(12);
    const yearTwoSavings = cumulativeSavingsAtMonth(24);
    const fiveYearSavings = cumulativeSavingsAtMonth(60);

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
      const extCost = externalTotalPerOrder * ordersPerMonth * m;
      externalCosts.push(Math.round(extCost * 100) / 100);
      // Own costs: upfront + variable + month-aware fixed costs
      const totalFixed = isLease
        ? cuttingMachineMonthlyCost * m + leaseMonthlyPayment * Math.min(m, leaseDurationMonths)
        : cuttingMachineMonthlyCost * m;
      ownCosts.push(Math.round((upfrontCost + ownVariablePerOrder * ordersPerMonth * m + totalFixed) * 100) / 100);
      cumulativeSavings.push(Math.round(cumulativeSavingsAtMonth(m) * 100) / 100);
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
    // Margins use variable per order (fair comparison - fixed costs are overhead)
    const marginExternal = Math.round((consumerPriceExclTax - externalTotalPerOrder) * 100) / 100;
    const marginOwn = Math.round((consumerPriceExclTax - ownVariablePerOrder) * 100) / 100;
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
      leaseDurationMonths,
      leaseDeposit,
      ordersPerMonth,
      externalCardPrice,
      externalHandling,
      externalShipping,
      paperPricePerSheet,
      cardsPerSheet,
      printCostPerSheet,
      docucutterPartsPerSheet,
      ownShippingCost,
      envelopePrice,
      thermicLabelPrice,
      cuttingMachineMonthlyCost,
    };

    const r3 = (v: number) => Math.round(v * 1000) / 1000;
    const r2 = (v: number) => Math.round(v * 100) / 100;
    const r4 = (v: number) => Math.round(v * 10000) / 10000;

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
        cardPrice: r2(externalCardPriceScaled),
        handling: externalHandling,
        shipping: externalShipping,
        totalPerOrder: r2(externalTotalPerOrder),
        costPerCard: r4(externalCostPerCard),
      },
      own: {
        perSheet: {
          paper: r3(perSheetPaper),
          printClicks: r3(perSheetPrintClicks),
          docucutterService: r3(perSheetDocucutterService),
          docucutterParts: r3(perSheetDocucutterParts),
          depreciation: r3(perSheetDepreciation),
          total: r3(perSheetTotal),
        },
        paperCost: r3(ownPaperCost),
        printCost: r3(ownPrintCost),
        docucutterServiceCost: r3(ownDocucutterServiceCost),
        docucutterPartsCost: r3(ownDocucutterPartsCost),
        depreciationCost: r3(ownDepreciationCost),
        shippingCost: ownShippingCost,
        envelopePrice,
        thermicLabelPrice,
        variablePerOrder: r2(ownVariablePerOrder),
        totalPerOrder: r2(ownTotalPerOrder),
        costPerCard: r4(allInCostPerCard),
      },
      savings: {
        perOrder: r2(savingsPerOrder),
        perMonth: r2(savingsPerMonth),
        percentage: r2(savingsPercentage),
      },
      breakeven: {
        orders: breakEvenOrders,
        months: r2(breakEvenMonths),
        years: r2(breakEvenYears),
      },
      projections: {
        yearOne: r2(yearOneSavings),
        yearTwo: r2(yearTwoSavings),
        fiveYear: r2(fiveYearSavings),
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
