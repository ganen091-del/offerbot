import { randomUUID } from "node:crypto";
import { and, eq, gte, sql } from "drizzle-orm";
import {
  db,
  telegramAccessUsers,
  telegramBalanceTransactions,
  telegramBalances,
  telegramOffers,
} from "@workspace/db";

export type TelegramCurrency = "stars" | "gram" | "rub";

export async function activateTelegramUser(userId: number): Promise<void> {
  await db
    .insert(telegramAccessUsers)
    .values({ userId })
    .onConflictDoNothing({ target: telegramAccessUsers.userId });
}

export async function isTelegramUserActivated(
  userId: number,
): Promise<boolean> {
  const rows = await db
    .select({ userId: telegramAccessUsers.userId })
    .from(telegramAccessUsers)
    .where(eq(telegramAccessUsers.userId, userId))
    .limit(1);
  return rows.length > 0;
}

export async function creditTelegramBalance(input: {
  userId: number;
  amount: string;
  currency: TelegramCurrency;
  adminUserId: number;
  updateId: number;
}): Promise<{ balance: string; duplicate: boolean }> {
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(telegramBalanceTransactions)
      .values({
        id: randomUUID(),
        operationKey: `admin-add:${input.updateId}`,
        userId: input.userId,
        currency: input.currency,
        amount: input.amount,
        kind: "admin_add",
        actorUserId: input.adminUserId,
      })
      .onConflictDoNothing({
        target: telegramBalanceTransactions.operationKey,
      })
      .returning({ id: telegramBalanceTransactions.id });

    if (inserted.length > 0) {
      await tx
        .insert(telegramBalances)
        .values({
          userId: input.userId,
          currency: input.currency,
          balance: input.amount,
        })
        .onConflictDoUpdate({
          target: [telegramBalances.userId, telegramBalances.currency],
          set: {
            balance: sql`${telegramBalances.balance} + ${input.amount}`,
            updatedAt: new Date(),
          },
        });
    }

    const [row] = await tx
      .select({ balance: telegramBalances.balance })
      .from(telegramBalances)
      .where(
        and(
          eq(telegramBalances.userId, input.userId),
          eq(telegramBalances.currency, input.currency),
        ),
      )
      .limit(1);

    return { balance: row?.balance ?? "0", duplicate: inserted.length === 0 };
  });
}

export async function telegramUserCanAfford(input: {
  userId: number;
  amount: string;
  currency: TelegramCurrency;
}): Promise<boolean> {
  const rows = await db
    .select({ userId: telegramBalances.userId })
    .from(telegramBalances)
    .where(
      and(
        eq(telegramBalances.userId, input.userId),
        eq(telegramBalances.currency, input.currency),
        gte(telegramBalances.balance, input.amount),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export async function saveTelegramOffer(input: {
  id: string;
  businessConnectionId: string;
  chatId: number;
  messageId: number;
  senderUserId: number;
  recipientUserId: number;
  nftUrl: string;
  nftTitle: string;
  amount: string;
  currency: TelegramCurrency;
}): Promise<void> {
  await db.insert(telegramOffers).values({
    ...input,
    status: "pending",
  });
}

type OfferActionResult =
  | { status: "missing" }
  | { status: "not_recipient" }
  | { status: "rejected"; offer: typeof telegramOffers.$inferSelect }
  | { status: "closed"; offer: typeof telegramOffers.$inferSelect }
  | { status: "insufficient"; offer: typeof telegramOffers.$inferSelect }
  | { status: "accepted"; offer: typeof telegramOffers.$inferSelect };

export async function acceptTelegramOffer(
  offerId: string,
  recipientUserId: number,
): Promise<OfferActionResult> {
  return db.transaction(async (tx) => {
    const [offer] = await tx
      .select()
      .from(telegramOffers)
      .where(eq(telegramOffers.id, offerId))
      .for("update");

    if (!offer) {
      return { status: "missing" };
    }

    if (offer.recipientUserId !== recipientUserId) {
      return { status: "not_recipient" };
    }

    if (offer.status === "accepted") {
      return { status: "accepted", offer };
    }

    if (offer.status !== "pending") {
      return { status: "closed", offer };
    }

    const [updatedBalance] = await tx
      .update(telegramBalances)
      .set({
        balance: sql`${telegramBalances.balance} - ${offer.amount}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(telegramBalances.userId, offer.senderUserId),
          eq(telegramBalances.currency, offer.currency),
          gte(telegramBalances.balance, offer.amount),
        ),
      )
      .returning({ balance: telegramBalances.balance });

    if (!updatedBalance) {
      return { status: "insufficient", offer };
    }

    await tx
      .insert(telegramBalanceTransactions)
      .values({
        id: randomUUID(),
        operationKey: `offer-debit:${offer.id}`,
        userId: offer.senderUserId,
        currency: offer.currency,
        amount: `-${offer.amount}`,
        kind: "offer_debit",
        actorUserId: offer.senderUserId,
        offerId: offer.id,
      })
      .onConflictDoNothing({
        target: telegramBalanceTransactions.operationKey,
      });

    await tx
      .update(telegramOffers)
      .set({ status: "accepted", updatedAt: new Date() })
      .where(eq(telegramOffers.id, offer.id));

    return { status: "accepted", offer: { ...offer, status: "accepted" } };
  });
}

export async function rejectTelegramOffer(
  offerId: string,
  recipientUserId: number,
): Promise<OfferActionResult> {
  return db.transaction(async (tx) => {
    const [offer] = await tx
      .select()
      .from(telegramOffers)
      .where(eq(telegramOffers.id, offerId))
      .for("update");

    if (!offer) {
      return { status: "missing" };
    }

    if (offer.recipientUserId !== recipientUserId) {
      return { status: "not_recipient" };
    }

    if (offer.status === "rejected") {
      return { status: "rejected", offer };
    }

    if (offer.status !== "pending") {
      return { status: "closed", offer };
    }

    await tx
      .update(telegramOffers)
      .set({ status: "rejected", updatedAt: new Date() })
      .where(eq(telegramOffers.id, offer.id));

    return { status: "rejected", offer: { ...offer, status: "rejected" } };
  });
}

export async function getTelegramOffer(
  offerId: string,
): Promise<typeof telegramOffers.$inferSelect | undefined> {
  const [offer] = await db
    .select()
    .from(telegramOffers)
    .where(eq(telegramOffers.id, offerId))
    .limit(1);
  return offer;
}
