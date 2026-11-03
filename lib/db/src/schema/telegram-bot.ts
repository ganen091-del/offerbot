import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import {
  bigint,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const telegramAccessUsers = pgTable("telegram_access_users", {
  userId: bigint("user_id", { mode: "number" }).primaryKey(),
  activatedAt: timestamp("activated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const telegramActivityAdmins = pgTable("telegram_activity_admins", {
  userId: bigint("user_id", { mode: "number" }).primaryKey(),
  username: text("username").notNull(),
  registeredAt: timestamp("registered_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const telegramRecipientPermissions = pgTable("telegram_recipient_permissions", {
  username: text("username").primaryKey(),
  userId: bigint("user_id", { mode: "number" }),
  grantedByUserId: bigint("granted_by_user_id", { mode: "number" }).notNull(),
  grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
});

export const telegramBalances = pgTable(
  "telegram_balances",
  {
    userId: bigint("user_id", { mode: "number" }).notNull(),
    currency: text("currency").notNull(),
    balance: numeric("balance", { precision: 30, scale: 8 })
      .notNull()
      .default("0"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [primaryKey({ columns: [table.userId, table.currency] })],
);

export const telegramBalanceTransactions = pgTable(
  "telegram_balance_transactions",
  {
    id: text("id").primaryKey(),
    operationKey: text("operation_key").notNull(),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    currency: text("currency").notNull(),
    amount: numeric("amount", { precision: 30, scale: 8 }).notNull(),
    kind: text("kind").notNull(),
    actorUserId: bigint("actor_user_id", { mode: "number" }).notNull(),
    offerId: text("offer_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex("telegram_balance_operation_key_uq").on(table.operationKey)],
);

export const telegramOffers = pgTable("telegram_offers", {
  id: text("id").primaryKey(),
  businessConnectionId: text("business_connection_id").notNull(),
  chatId: bigint("chat_id", { mode: "number" }).notNull(),
  messageId: integer("message_id").notNull(),
  senderUserId: bigint("sender_user_id", { mode: "number" }).notNull(),
  recipientUserId: bigint("recipient_user_id", { mode: "number" }).notNull(),
  nftUrl: text("nft_url").notNull(),
  nftTitle: text("nft_title").notNull(),
  nftRecipientUsername: text("nft_recipient_username")
    .notNull()
    .default("GarantXNotcoin"),
  amount: numeric("amount", { precision: 30, scale: 8 }).notNull(),
  currency: text("currency").notNull(),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}, (table) => [index("telegram_offers_sender_created_idx").on(table.senderUserId, table.createdAt)]);

export const insertTelegramAccessUserSchema =
  createInsertSchema(telegramAccessUsers).omit({ activatedAt: true });
export const insertTelegramBalanceSchema = createInsertSchema(telegramBalances)
  .omit({ updatedAt: true })
  .extend({
    currency: z.enum(["stars", "gram", "rub", "uah"]),
  });
export const insertTelegramBalanceTransactionSchema =
  createInsertSchema(telegramBalanceTransactions).omit({ createdAt: true });
export const insertTelegramOfferSchema = createInsertSchema(telegramOffers)
  .omit({ createdAt: true, updatedAt: true })
  .extend({
    currency: z.enum(["stars", "gram", "rub", "uah"]),
    status: z.enum(["pending", "accepted", "rejected"]),
  });

export type InsertTelegramAccessUser = z.infer<
  typeof insertTelegramAccessUserSchema
>;
export type TelegramAccessUser = typeof telegramAccessUsers.$inferSelect;
export type InsertTelegramBalance = z.infer<
  typeof insertTelegramBalanceSchema
>;
export type TelegramBalance = typeof telegramBalances.$inferSelect;
export type InsertTelegramBalanceTransaction = z.infer<
  typeof insertTelegramBalanceTransactionSchema
>;
export type TelegramBalanceTransaction =
  typeof telegramBalanceTransactions.$inferSelect;
export type InsertTelegramOffer = z.infer<typeof insertTelegramOfferSchema>;
export type TelegramOffer = typeof telegramOffers.$inferSelect;
