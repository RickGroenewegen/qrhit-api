/**
 * The admin's Order status board: every company list as a sticky in one of
 * six columns, from first interest to delivered (frontend
 * `src/app/admin-order-status/`).
 *
 * The column is `CompanyList.orderStatus`, not `status`: that one belongs to
 * the old voting wizard and the API rewrites it by itself (every `new` list
 * of a company becomes `company` when the company is saved, finalizeList sets
 * `spotify_list_generated`). The board is independent of the Sold toggle too:
 * Agreed does not make a list a sale, the toggle and its date do.
 *
 * Reseller or client is the Reseller switch of the list's own calculator, so
 * a list that has not been calculated shows as a client. A sticky's deadline
 * is the list's delivery date; the warnings (Schneider's lead time) are
 * worked out by the page.
 */
import { Prisma } from '@prisma/client';
import PrismaInstance from './prisma';
import { listBoxes, listCalculationState, listPrinterVariant, ListVariant, round2 } from './listPricing';

export const ORDER_STATUSES = [
  'interest',
  'contact',
  'offer_sent',
  'agreed',
  'in_production',
  'delivered',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  interest: 'Interest',
  contact: 'Contact',
  offer_sent: 'Sent offer',
  agreed: 'Agreed',
  in_production: 'In production',
  delivered: 'Delivered',
};

export const ORDER_NOTE_MAX = 500;

export function isOrderStatus(value: unknown): value is OrderStatus {
  return typeof value === 'string' && (ORDER_STATUSES as readonly string[]).includes(value);
}

export const BOARD_LIST_SELECT = {
  id: true,
  companyId: true,
  name: true,
  printer: true,
  numberOfCards: true,
  numberOfBoxes: true,
  calculationTromp: true,
  calculationSchneider: true,
  buyPrice: true,
  sellPrice: true,
  sold: true,
  desiredDeliveryDate: true,
  deliveryAsap: true,
  orderStatus: true,
  orderStatusAt: true,
  orderPosition: true,
  orderNote: true,
  orderArchived: true,
  contactUserId: true,
  createdAt: true,
  Company: {
    select: { id: true, name: true, contact: true, contactemail: true, contactphone: true },
  },
  ContactUser: {
    select: { id: true, displayName: true, email: true, phone: true },
  },
} satisfies Prisma.CompanyListSelect;

export type BoardList = Prisma.CompanyListGetPayload<{ select: typeof BOARD_LIST_SELECT }>;

export interface BoardContact {
  name: string;
  email: string | null;
  phone: string | null;
  /** No contact picked: the company's own contact. */
  fromCompany: boolean;
}

export interface BoardCard {
  id: number;
  companyId: number;
  companyName: string;
  name: string;
  orderStatus: OrderStatus;
  orderStatusAt: Date | null;
  orderPosition: number;
  orderNote: string | null;
  orderArchived: boolean;
  contactUserId: number | null;
  contact: BoardContact | null;
  printer: ListVariant;
  boxes: number;
  /** Cards per box (Schneider) or per set (Tromp); null when unknown. */
  cardsPerBox: number | null;
  /** Tromp only: eigen, voorbedrukt, klein or luxe. */
  trompPrintingType: string | null;
  /** Tromp sold it: the sell price is our license fee. */
  trompSold: boolean;
  isReseller: boolean;
  /** Excl. VAT, after discount: what the invoices add up to. */
  sellPrice: number | null;
  buyPrice: number | null;
  /** sellPrice - buyPrice; null while either is unknown. */
  profit: number | null;
  sold: boolean;
  desiredDeliveryDate: Date | null;
  deliveryAsap: boolean;
  createdAt: Date;
}

function boardContact(list: BoardList): BoardContact | null {
  const user = list.ContactUser;
  if (user) {
    return {
      name: user.displayName || user.email,
      email: user.email,
      phone: user.phone || null,
      fromCompany: false,
    };
  }
  const company = list.Company;
  if (!company?.contact && !company?.contactemail) return null;
  return {
    name: company.contact || company.contactemail || '',
    email: company.contactemail || null,
    phone: company.contactphone || null,
    fromCompany: true,
  };
}

export function toBoardCard(list: BoardList): BoardCard {
  const printer = listPrinterVariant(list.printer);
  const state = listCalculationState(list);
  const trompSold = printer === 'qrsong' && (state.trompSold === true || state.pricing?.trompSold === true);
  const cards =
    printer === 'schneider'
      ? Number(state.cardCount) || list.numberOfCards
      : (trompSold && Number(state.licenseCards)) || list.numberOfCards;
  const profit =
    list.buyPrice != null && list.sellPrice != null ? round2(list.sellPrice - list.buyPrice) : null;

  return {
    id: list.id,
    companyId: list.companyId,
    companyName: list.Company?.name ?? '',
    name: list.name,
    orderStatus: isOrderStatus(list.orderStatus) ? list.orderStatus : 'interest',
    orderStatusAt: list.orderStatusAt,
    orderPosition: list.orderPosition,
    orderNote: list.orderNote,
    orderArchived: list.orderArchived,
    contactUserId: list.contactUserId,
    contact: boardContact(list),
    printer,
    boxes: listBoxes(list),
    cardsPerBox: cards > 0 ? cards : null,
    trompPrintingType:
      printer === 'qrsong' && typeof state.printingType === 'string' ? state.printingType : null,
    trompSold,
    isReseller: state.isReseller === true,
    sellPrice: list.sellPrice,
    buyPrice: list.buyPrice,
    profit,
    sold: list.sold,
    desiredDeliveryDate: list.desiredDeliveryDate,
    deliveryAsap: list.deliveryAsap,
    createdAt: list.createdAt,
  };
}

export interface OrderBoardFields {
  orderStatus?: OrderStatus;
  orderNote?: string | null;
  orderArchived?: boolean;
  contactUserId?: number | null;
  /** The deadline is the list's delivery date, stored at 12:00 UTC. */
  desiredDeliveryDate?: Date | null;
  deliveryAsap?: boolean;
}

/**
 * The board fields a request body carries, validated. Fields it does not
 * carry are left out. Whether a contact belongs to the list's company is
 * checked by `completeOrderBoardUpdate`, which needs the list.
 */
export function parseOrderBoardFields(
  body: Record<string, any>
): { data: OrderBoardFields } | { error: string } {
  const data: OrderBoardFields = {};

  if (body.orderStatus !== undefined) {
    if (!isOrderStatus(body.orderStatus)) return { error: 'Invalid order status' };
    data.orderStatus = body.orderStatus;
  }

  if (body.orderNote !== undefined) {
    if (body.orderNote !== null && typeof body.orderNote !== 'string') {
      return { error: 'orderNote must be a string or null' };
    }
    const note = (body.orderNote ?? '').trim();
    if (note.length > ORDER_NOTE_MAX) {
      return { error: `The note can be at most ${ORDER_NOTE_MAX} characters` };
    }
    data.orderNote = note || null;
  }

  if (body.orderArchived !== undefined) {
    if (typeof body.orderArchived !== 'boolean') return { error: 'orderArchived must be true or false' };
    data.orderArchived = body.orderArchived;
  }

  if (body.contactUserId !== undefined) {
    if (body.contactUserId === null) {
      data.contactUserId = null;
    } else {
      const id = Number(body.contactUserId);
      if (!Number.isInteger(id) || id < 1) return { error: 'Invalid contact' };
      data.contactUserId = id;
    }
  }

  // A day: YYYY-MM-DD becomes 12:00 UTC, so it reads as that date everywhere.
  if (body.desiredDeliveryDate !== undefined) {
    if (body.desiredDeliveryDate === null || body.desiredDeliveryDate === '') {
      data.desiredDeliveryDate = null;
    } else {
      const raw = String(body.desiredDeliveryDate);
      const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T12:00:00.000Z` : raw);
      if (isNaN(date.getTime())) return { error: 'Invalid deadline' };
      data.desiredDeliveryDate = date;
    }
  }

  if (body.deliveryAsap !== undefined) {
    if (typeof body.deliveryAsap !== 'boolean') return { error: 'deliveryAsap must be true or false' };
    data.deliveryAsap = body.deliveryAsap;
  }

  return { data };
}

export interface StatusChange {
  from: OrderStatus;
  to: OrderStatus;
}

/**
 * The parts of a board update that need the list: the contact must be a
 * user of the list's company, and a changed column stamps `orderStatusAt`
 * and puts the list on top of its new column (unless the caller placed it).
 * Fills those into `data` and says whether the column changed.
 */
export async function completeOrderBoardUpdate(
  data: Record<string, any>,
  list: { id: number; companyId: number; orderStatus: string }
): Promise<{ error: string } | { statusChange: StatusChange | null }> {
  const prisma = PrismaInstance.getInstance();

  if (typeof data.contactUserId === 'number') {
    const user = await prisma.user.findUnique({
      where: { id: data.contactUserId },
      select: { companyId: true },
    });
    if (!user || user.companyId !== list.companyId) {
      return { error: 'The contact is not a user of this company' };
    }
  }

  const from: OrderStatus = isOrderStatus(list.orderStatus) ? list.orderStatus : 'interest';
  if (data.orderStatus === undefined || data.orderStatus === from) {
    delete data.orderStatus;
    return { statusChange: null };
  }

  data.orderStatusAt = new Date();
  if (data.orderPosition === undefined) {
    const top = await prisma.companyList.aggregate({
      where: { orderStatus: data.orderStatus, NOT: { id: list.id } },
      _min: { orderPosition: true },
    });
    data.orderPosition = (top._min.orderPosition ?? 1) - 1;
  }
  return { statusChange: { from, to: data.orderStatus } };
}

/** A line on the company's Timeline. */
export async function recordStatusChange(
  companyId: number,
  userId: number | null,
  listName: string,
  change: StatusChange
): Promise<void> {
  const prisma = PrismaInstance.getInstance();
  await prisma.companyEvent.create({
    data: {
      companyId,
      userId: userId || null,
      type: 'status_change',
      content: `Order status of “${listName}”: ${ORDER_STATUS_LABELS[change.from]} → ${ORDER_STATUS_LABELS[change.to]}`,
    },
  });
}

/** Every list of every company, archived ones included (the page filters). */
export async function getOrderBoard(): Promise<BoardCard[]> {
  const prisma = PrismaInstance.getInstance();
  const lists = await prisma.companyList.findMany({
    select: BOARD_LIST_SELECT,
    orderBy: [{ orderPosition: 'asc' }, { createdAt: 'desc' }],
  });
  return lists.map(toBoardCard);
}

export type BoardUpdateResult =
  | { success: true; card: BoardCard }
  | { success: false; status: number; error: string };

/**
 * A change from the board: a drop (`orderStatus` and `orderIds`, the target
 * column's ids in their new order), or the sticky's edit (contact, note,
 * deadline, status, archive).
 */
export async function updateBoardList(
  listId: number,
  body: Record<string, any>,
  userId: number | null
): Promise<BoardUpdateResult> {
  const parsed = parseOrderBoardFields(body);
  if ('error' in parsed) return { success: false, status: 400, error: parsed.error };

  let orderIds: number[] | null = null;
  if (body.orderIds !== undefined) {
    if (
      !Array.isArray(body.orderIds) ||
      body.orderIds.length > 1000 ||
      !body.orderIds.every((id: unknown) => Number.isInteger(id))
    ) {
      return { success: false, status: 400, error: 'orderIds must be a list of list ids' };
    }
    orderIds = body.orderIds;
  }

  const data: Record<string, any> = { ...parsed.data };
  if (orderIds) {
    const index = orderIds.indexOf(listId);
    if (index >= 0) data.orderPosition = index;
  }
  if (Object.keys(data).length === 0 && !orderIds) {
    return { success: false, status: 400, error: 'No fields to update' };
  }

  const prisma = PrismaInstance.getInstance();
  const list = await prisma.companyList.findUnique({
    where: { id: listId },
    select: { id: true, companyId: true, name: true, orderStatus: true },
  });
  if (!list) return { success: false, status: 404, error: 'List not found' };

  const completed = await completeOrderBoardUpdate(data, list);
  if ('error' in completed) return { success: false, status: 400, error: completed.error };

  const target = data.orderStatus ?? list.orderStatus;
  await prisma.$transaction([
    prisma.companyList.update({ where: { id: listId }, data }),
    // The rest of the target column takes the positions of the drop.
    ...(orderIds ?? [])
      .map((id, position) => ({ id, position }))
      .filter(({ id }) => id !== listId)
      .map(({ id, position }) =>
        prisma.companyList.updateMany({
          where: { id, orderStatus: target },
          data: { orderPosition: position },
        })
      ),
  ]);

  if (completed.statusChange) {
    await recordStatusChange(list.companyId, userId, list.name, completed.statusChange);
  }

  const updated = await prisma.companyList.findUniqueOrThrow({
    where: { id: listId },
    select: BOARD_LIST_SELECT,
  });
  return { success: true, card: toBoardCard(updated) };
}
