import { bigint, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * One strongly isolated JSON document per bot store.  The bot's existing
 * records are heterogeneous and already have carefully reviewed validation
 * and state-machine code at their call sites; retaining their original JSON
 * text avoids PostgreSQL JSONB's prohibition on NUL characters in composite
 * keys while PostgreSQL still supplies cross-process transactions and row
 * locks.
 */
export const botDocuments = pgTable("bot_documents", {
  name: text("name").primaryKey(),
  document: text("document").notNull(),
  revision: bigint("revision", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});