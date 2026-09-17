import { json } from '@/lib/http';

// Unknown API paths get a JSON 404 instead of Next.js's HTML page.
const notFound = () => json({ error: { code: 'not_found', message: 'No such API endpoint' } }, { status: 404 });

export { notFound as GET, notFound as POST, notFound as PUT, notFound as PATCH, notFound as DELETE };
