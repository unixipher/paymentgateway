import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

process.env.DB_PATH = ':memory:';
process.env.GOOGLE_CLIENT_ID = 'test';
process.env.GOOGLE_CLIENT_SECRET = 'test';
process.env.SESSION_SECRET = 'x'.repeat(32);

const { db } = await import('../src/db.js');
const { claimUtr, createOrder, getOrder, recordBankTxn } = await import('../src/orders.js');

const merchant = { id: 'mer_1', email: 'me@gmail.com', vpa: 'me@okhdfcbank' };
db.prepare(`INSERT INTO merchants (id, email, vpa, webhook_secret, api_key, created_at) VALUES (?, ?, ?, 's', 'k', 0)`)
  .run(merchant.id, merchant.email, merchant.vpa);

let gmailId = 0;
const bankEmail = (amountPaise, utr, receivedAt = Date.now()) =>
  recordBankTxn(merchant.id, { gmailId: `msg${++gmailId}`, amountPaise, utr, payerVpa: null, bankDomain: 'hdfcbank.net', receivedAt });

beforeEach(() => db.exec('DELETE FROM orders; DELETE FROM bank_txns;'));

test('two people paying ₹10 at the same time get different amounts and are matched correctly', () => {
  const mine = createOrder(merchant, { amount: '10' });
  const friends = createOrder(merchant, { amount: '10' });
  assert.equal(mine.amount_paise, 1001);
  assert.equal(friends.amount_paise, 1002);

  assert.equal(bankEmail(1002, '425100000002').id, friends.id);
  assert.equal(getOrder(mine.id).status, 'pending');
  assert.equal(getOrder(friends.id).status, 'paid');

  assert.equal(bankEmail(1001, '425100000001').id, mine.id);
  assert.equal(getOrder(mine.id).paid_utr, '425100000001');
});

test('the same UTR can never pay twice', () => {
  const a = createOrder(merchant, { amount: '10' });
  bankEmail(1001, '425100000010');
  const b = createOrder(merchant, { amount: '10' }); // re-uses ₹10.01 now that it's free
  assert.equal(b.amount_paise, 1001);
  assert.equal(bankEmail(1001, '425100000010'), null); // replayed/duplicate alert
  assert.equal(getOrder(a.id).status, 'paid');
  assert.equal(getOrder(b.id).status, 'pending');
});

test('payments that arrived before the order was created do not count', () => {
  const order = createOrder(merchant, { amount: '10' });
  assert.equal(bankEmail(1001, '425100000020', order.created_at - 60 * 60_000), null);
  assert.equal(getOrder(order.id).status, 'pending');
});

test('a rounded payment is matched once the payer submits their UTR (either order)', () => {
  const early = createOrder(merchant, { amount: '10' });
  bankEmail(1000, '425100000030'); // paid ₹10.00 instead of ₹10.01: nothing to match yet
  assert.equal(getOrder(early.id).status, 'pending');
  assert.equal(claimUtr(early.id, '425100000030').status, 'paid');

  const late = createOrder(merchant, { amount: '10' });
  claimUtr(late.id, '425100000031');
  assert.equal(getOrder(late.id).status, 'pending');
  assert.equal(bankEmail(1000, '425100000031').id, late.id);
});

test("knowing a friend's UTR doesn't steal their exact-amount payment", () => {
  const friends = createOrder(merchant, { amount: '10' });
  const mine = createOrder(merchant, { amount: '10' });
  claimUtr(mine.id, '425100000040'); // attacker claims the friend's UTR before the email arrives
  assert.equal(bankEmail(friends.amount_paise, '425100000040').id, friends.id);
  assert.equal(getOrder(mine.id).status, 'pending');
});

test('UTR claims must match the order amount', () => {
  const order = createOrder(merchant, { amount: '10' });
  bankEmail(500, '425100000050');
  assert.equal(claimUtr(order.id, '425100000050').status, 'pending');
});

test('input validation', () => {
  assert.throws(() => createOrder(merchant, { amount: '0.5' }), /amount/);
  assert.throws(() => createOrder(merchant, { amount: 'abc' }), /amount/);
  assert.throws(() => createOrder({ ...merchant, vpa: null }, { amount: '10' }), /UPI ID/);
  const order = createOrder(merchant, { amount: '10' });
  assert.throws(() => claimUtr(order.id, '123'), /12 digits/);
});
