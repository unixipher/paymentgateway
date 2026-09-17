import { describe, expect, test } from 'vitest';
import { decrypt, encrypt, sign, unsign } from '@/lib/crypto';
import { webhookUrlSchema } from '@/lib/merchants';
import { safeRedirectPath, verifyOAuthState } from '@/lib/oauth-state';
import { signWebhook, verifyWebhookSignature } from '@/lib/webhooks';

describe('encryption', () => {
  test('round-trips and uses a fresh IV each time', () => {
    const a = encrypt('refresh-token');
    const b = encrypt('refresh-token');
    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe('refresh-token');
  });

  test('tampered ciphertext is rejected', () => {
    const parts = encrypt('secret').split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decrypt(parts.join('.'))).toThrow();
  });
});

describe('signed values', () => {
  test('unsign accepts only untampered values', () => {
    const signed = sign('hello');
    expect(unsign(signed)).toBe('hello');
    expect(unsign(signed.replace('hello', 'hellp'))).toBeNull();
  });

  test('OAuth state must match, be fresh, and carry a safe redirect', () => {
    const cookie = (payload: object) => sign(JSON.stringify(payload));
    const future = Date.now() + 60_000;
    expect(verifyOAuthState(cookie({ nonce: 'abc', redirect: '/orders', exp: future }), 'abc')).toEqual({ redirect: '/orders' });
    expect(verifyOAuthState(cookie({ nonce: 'abc', redirect: '/orders', exp: future }), 'xyz')).toBeNull();
    expect(verifyOAuthState(cookie({ nonce: 'abc', exp: Date.now() - 1 }), 'abc')).toBeNull();
    expect(verifyOAuthState(cookie({ nonce: 'abc', redirect: '//evil.com', exp: future }), 'abc')).toEqual({ redirect: null });
    expect(verifyOAuthState(undefined, 'abc')).toBeNull();
  });

  test.each(['//evil.com', 'https://evil.com', '/\\evil.com', 'orders'])('rejects unsafe redirect %s', (path) => {
    expect(safeRedirectPath(path)).toBeNull();
  });
});

describe('webhook signatures', () => {
  test('verifies a valid signature and rejects tampering and replays', () => {
    const body = JSON.stringify({ id: 'evt_1', type: 'order.paid' });
    const header = signWebhook('whsec_test', body);
    expect(verifyWebhookSignature('whsec_test', body, header)).toBe(true);
    expect(verifyWebhookSignature('whsec_other', body, header)).toBe(false);
    expect(verifyWebhookSignature('whsec_test', `${body} `, header)).toBe(false);
    expect(verifyWebhookSignature('whsec_test', body, header, Date.now() + 10 * 60_000)).toBe(false);
  });
});

describe('webhook URL validation', () => {
  test('allows http(s) outside production', () => {
    expect(webhookUrlSchema.safeParse('http://localhost:4000/hook').success).toBe(true);
    expect(webhookUrlSchema.safeParse('ftp://example.com').success).toBe(false);
  });
});
