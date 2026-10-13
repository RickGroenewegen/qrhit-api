/**
 * Put the lists that existed before the Order status board in a first column.
 *
 * `db push` gives every list `orderStatus = 'interest'`. This is a one-time
 * best guess on top of that: a sold list is Agreed, a list with a quotation
 * is Sent offer, the rest stays Interest. It only touches lists that were
 * never moved by hand (`orderStatusAt` null), so running it again changes
 * nothing that was sorted on the board since.
 *
 *   npx tsx scripts/backfill-order-status.ts          # report only
 *   npx tsx scripts/backfill-order-status.ts --write  # update
 *
 * Needs the order* columns: run `npx prisma db push` first.
 */
import 'dotenv/config';
import { color, white } from 'console-log-colors';
import PrismaInstance from '../src/prisma';
import { ORDER_STATUSES, ORDER_STATUS_LABELS, OrderStatus } from '../src/orderBoard';

const write = process.argv.includes('--write');

async function main(): Promise<void> {
  const prisma = PrismaInstance.getInstance();
  const lists = await prisma.companyList.findMany({
    where: { orderStatusAt: null },
    select: { id: true, sold: true, orderStatus: true },
  });
  const quoted = new Set(
    (
      await prisma.quotation.findMany({
        where: { listId: { not: null } },
        select: { listId: true },
        distinct: ['listId'],
      })
    ).map((q) => q.listId)
  );

  const guess = (list: { id: number; sold: boolean }): OrderStatus =>
    list.sold ? 'agreed' : quoted.has(list.id) ? 'offer_sent' : 'interest';

  const byStatus = new Map<OrderStatus, number[]>();
  for (const list of lists) {
    const status = guess(list);
    if (status === list.orderStatus) continue;
    byStatus.set(status, [...(byStatus.get(status) ?? []), list.id]);
  }

  console.log(color.blue.bold(`${white.bold(String(lists.length))} lists were never moved on the board`));
  for (const status of ORDER_STATUSES) {
    const ids = byStatus.get(status);
    if (!ids?.length) continue;
    console.log(
      color.blue.bold(`  ${ORDER_STATUS_LABELS[status]}: ${white.bold(String(ids.length))} (${ids.join(', ')})`)
    );
  }
  if (!byStatus.size) {
    console.log(color.green.bold('Nothing to change.'));
    return;
  }
  if (!write) {
    console.log(color.yellow.bold('Dry run: run with --write to update them.'));
    return;
  }

  for (const [status, ids] of byStatus) {
    await prisma.companyList.updateMany({
      where: { id: { in: ids }, orderStatusAt: null },
      data: { orderStatus: status },
    });
  }
  console.log(color.green.bold('Updated.'));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(color.red.bold(`Backfill failed: ${white.bold(error.message)}`));
    process.exit(1);
  });
