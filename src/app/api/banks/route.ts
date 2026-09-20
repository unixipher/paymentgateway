import { bankChoices } from '@/lib/dlt';
import { handler, json } from '@/lib/http';

// The banks a merchant can say their account is with, from TRAI's register of SMS headers. Public
// and unchanging, so the dashboard can cache it.
export const GET = handler(async () =>
  json(
    { object: 'list', data: bankChoices().map(({ key, name }) => ({ key, name })) },
    { headers: { 'cache-control': 'public, max-age=86400' } },
  ));
