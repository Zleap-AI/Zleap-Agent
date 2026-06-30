import { describe, expect, it } from 'vitest';
import { GET } from '../app/api/health/live/route';

describe('/api/health/live route', () => {
  it('returns ok without authentication', async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; service: string };
    expect(body.status).toBe('ok');
    expect(body.service).toBe('zleap-web');
  });
});
