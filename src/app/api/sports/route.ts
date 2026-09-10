import { listSports } from '@/lib/services/queries';
import { ok, route } from '@/lib/api/http';

export const dynamic = 'force-dynamic';

export const GET = route(async () => ok(await listSports()));
