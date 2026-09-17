import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import pg from 'pg';

// These tests need Postgres. They run in their own `gateway_test` schema, rebuilt from the
// migrations on every run, so the real tables in `public` are never touched.
const TEST_SCHEMA = 'gateway_test';
const baseUrl = process.env.DATABASE_URL;
const skip = baseUrl ? false : 'DATABASE_URL not set';

let prisma;
let orders;
const merchant = { id: 'mer_test', email: 'me@gmail.com', vpa: 'me@okhdfcbank' };

before(async () => {
  if (skip) return;
  const pgUrl = new URL(baseUrl);
  pgUrl.searchParams.delete('schema');
  const client = new pg.Client({ connectionString: pgUrl.toString() });
  await client.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE; CREATE SCHEMA ${TEST_SCHEMA}; SET search_path TO ${TEST_SCHEMA};`);
    const migrations = path.join(import.meta.dirname, '..', 'prisma', 'migrations');
    for (const dir of fs.readdirSync(migrations).filter((d) => fs.statSync(path.join(migrations, d)).isDirectory()).sort()) {
      const sql = fs.readFileSync(path.join(migrations, dir, 'migration.sql'), 'utf8').replace(/^CREATE SCHEMA IF NOT EXISTS "public";$/m, '');
      await client.query(sql);
    }
  } finally {
    await client.end();
  }

  const testUrl = new URL(baseUrl);
  testUrl.searchParams.set('schema', TEST_SCHEMA);
  process.env.DATABASE_URL = testUrl.toString();
  process.env.GOOGLE_CLIENT_ID ??= 'test';
  process.env.GOOGLE_CLIENT_SECRET ??= 'test';
  process.env.SESSION_SECRET ??= 'x'.repeat(32);

  ({ prisma } = await import('../src/db.js'));
  orders = await import('../src/orders.js');
  await prisma.merchant.create({ data: { ...merchant, webhookSecret: 's', apiKey: 'k' } });
});

after(async () => {
  await prisma?.$disconnect();
});

beforeEach(async () => {
  if (skip) return;
  await prisma.bankTxn.deleteMany();
  await prisma.order.deleteMany();
});

let gmailId = 0;
const bankEmail = (amountPaise, utr, receivedAt = Date.now(), merchantId = merchant.id) =>
  orders.recordBankTxn(merchantId, { gmailMessageId: `msg${++gmailId}`, amountPaise, utr, payerVpa: null, bankDomain: 'hdfcbank.net', receivedAt });
const statusOf = async (id) => (await orders.getOrder(id)).status;

test('two people paying ₹10 at the same time get different amounts and are matched correctly', { skip }, async () => {
  const mine = await orders.createOrder(merchant, { amount: '10' });
  const friends = await orders.createOrder(merchant, { amount: '10' });
  assert.equal(mine.amountPaise, 1001);
  assert.equal(friends.amountPaise, 1002);

  assert.equal((await bankEmail(1002, '425100000002')).id, friends.id);
  assert.equal(await statusOf(mine.id), 'pending');
  assert.equal(await statusOf(friends.id), 'paid');

  assert.equal((await bankEmail(1001, '425100000001')).id, mine.id);
  assert.equal((await orders.getOrder(mine.id)).txn.utr, '425100000001');
});

test('orders created at the same instant never get the same amount', { skip }, async () => {
  const created = await Promise.all(Array.from({ length: 20 }, () => orders.createOrder(merchant, { amount: '10' })));
  assert.equal(new Set(created.map((o) => o.amountPaise)).size, 20);
});

test('the same UTR can never pay twice', { skip }, async () => {
  const a = await orders.createOrder(merchant, { amount: '10' });
  await bankEmail(1001, '425100000010');
  const b = await orders.createOrder(merchant, { amount: '10' }); // re-uses ₹10.01 now that it's free
  assert.equal(b.amountPaise, 1001);
  assert.equal(await bankEmail(1001, '425100000010'), null); // replayed/duplicate alert
  assert.equal(await statusOf(a.id), 'paid');
  assert.equal(await statusOf(b.id), 'pending');
});

test("one user's bank emails never pay another user's orders", { skip }, async () => {
  const other = await prisma.merchant.upsert({
    where: { id: 'mer_other' },
    update: {},
    create: { id: 'mer_other', email: 'other@gmail.com', vpa: 'other@ybl', webhookSecret: 's2', apiKey: 'k2' },
  });
  const mine = await orders.createOrder(merchant, { amount: '10' });
  const theirs = await orders.createOrder(other, { amount: '10' });
  assert.equal(theirs.amountPaise, 1001); // amounts are allocated per user

  assert.equal((await bankEmail(1001, '425100000060', Date.now(), other.id)).id, theirs.id);
  assert.equal(await statusOf(mine.id), 'pending');
  // The same UTR may legitimately show up for a different user (e.g. one paying the other).
  assert.equal((await bankEmail(1001, '425100000060')).id, mine.id);
});

test('payments that arrived before the order was created do not count', { skip }, async () => {
  const order = await orders.createOrder(merchant, { amount: '10' });
  assert.equal(await bankEmail(1001, '425100000020', order.createdAt.getTime() - 60 * 60_000), null);
  assert.equal(await statusOf(order.id), 'pending');
});

test('a rounded payment is matched once the payer submits their UTR (either order)', { skip }, async () => {
  const early = await orders.createOrder(merchant, { amount: '10' });
  await bankEmail(1000, '425100000030'); // paid ₹10.00 instead of ₹10.01: nothing to match yet
  assert.equal(await statusOf(early.id), 'pending');
  assert.equal((await orders.claimUtr(early.id, '425100000030')).status, 'paid');

  const late = await orders.createOrder(merchant, { amount: '10' });
  await orders.claimUtr(late.id, '425100000031');
  assert.equal(await statusOf(late.id), 'pending');
  assert.equal((await bankEmail(1000, '425100000031')).id, late.id);
});

test("knowing a friend's UTR doesn't steal their exact-amount payment", { skip }, async () => {
  const friends = await orders.createOrder(merchant, { amount: '10' });
  const mine = await orders.createOrder(merchant, { amount: '10' });
  await orders.claimUtr(mine.id, '425100000040'); // attacker claims the friend's UTR before the email arrives
  assert.equal((await bankEmail(friends.amountPaise, '425100000040')).id, friends.id);
  assert.equal(await statusOf(mine.id), 'pending');
});

test('UTR claims must match the order amount', { skip }, async () => {
  const order = await orders.createOrder(merchant, { amount: '10' });
  await bankEmail(500, '425100000050');
  assert.equal((await orders.claimUtr(order.id, '425100000050')).status, 'pending');
});

test('input validation', { skip }, async () => {
  await assert.rejects(orders.createOrder(merchant, { amount: '0.5' }), /amount/);
  await assert.rejects(orders.createOrder(merchant, { amount: 'abc' }), /amount/);
  await assert.rejects(orders.createOrder({ ...merchant, vpa: null }, { amount: '10' }), /UPI ID/);
  const order = await orders.createOrder(merchant, { amount: '10' });
  await assert.rejects(orders.claimUtr(order.id, '123'), /12 digits/);
});
