import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const file = process.env.DB_PATH ?? path.join(import.meta.dirname, '..', 'data', 'gateway.db');
if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });

export const db = new DatabaseSync(file);

// All timestamps are milliseconds since epoch, all money is integer paise.
db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS merchants (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    refresh_token TEXT,               -- encrypted; NULL when Google access was revoked
    vpa TEXT,
    display_name TEXT,
    webhook_url TEXT,
    webhook_secret TEXT NOT NULL,
    api_key TEXT UNIQUE NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL REFERENCES merchants(id),
    base_paise INTEGER NOT NULL,      -- what the merchant asked for
    amount_paise INTEGER NOT NULL,    -- base + unique paise offset the payer must pay
    note TEXT,
    redirect_url TEXT,
    status TEXT NOT NULL DEFAULT 'pending',  -- pending | paid (expiry is computed from time)
    claimed_utr TEXT,
    txn_id TEXT REFERENCES bank_txns(id),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    paid_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS orders_by_amount ON orders(merchant_id, status, amount_paise);

  CREATE TABLE IF NOT EXISTS bank_txns (
    id TEXT PRIMARY KEY,              -- Gmail message id
    merchant_id TEXT NOT NULL REFERENCES merchants(id),
    amount_paise INTEGER NOT NULL,
    utr TEXT,
    payer_vpa TEXT,
    bank_domain TEXT,
    received_at INTEGER NOT NULL,
    order_id TEXT UNIQUE,             -- a bank credit can pay at most one order
    UNIQUE (merchant_id, utr)         -- the same UTR can never be counted twice
  );

  CREATE TABLE IF NOT EXISTS gmail_messages (
    id TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL REFERENCES merchants(id),
    received_at INTEGER NOT NULL,
    from_addr TEXT,
    subject TEXT,
    verdict TEXT NOT NULL
  );
`);
