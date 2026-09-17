import { json } from '@/lib/http';

export function GET() {
  return json({ name: 'paymentgateway', docs: 'https://github.com/unixipher/paymentgateway/blob/main/docs/API.md' });
}
