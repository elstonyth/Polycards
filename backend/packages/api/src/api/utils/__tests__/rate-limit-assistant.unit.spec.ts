import type { MedusaRequest } from '@medusajs/framework/http';
import { ASSISTANT_REPORT_KEY } from '../../admin/assistant/bridge';
import { RATE_LIMITS } from '../rate-limit';

// The admin assistant's loopback report calls all come from 127.0.0.1: with
// its in-process key each staff member gets their own bucket; anyone else is
// still keyed by address.
const keyOf = (RATE_LIMITS['desk-reports'] as { keyOf: (r: MedusaRequest) => string }).keyOf;
const req = (headers: Record<string, string>) =>
  ({ originalUrl: '/reports/finance/economy', headers, ip: '127.0.0.1', socket: {} }) as unknown as MedusaRequest;

describe('desk-reports limiter key', () => {
  it('gives each staff member using the assistant their own bucket', () => {
    const a = keyOf(req({ 'x-report-key': ASSISTANT_REPORT_KEY, 'x-assistant-user': 'user_a' }));
    const b = keyOf(req({ 'x-report-key': ASSISTANT_REPORT_KEY, 'x-assistant-user': 'user_b' }));
    expect(a).toBe('finance:assistant:user_a');
    expect(b).not.toBe(a);
  });

  it('never lets a caller without the key pick its own bucket', () => {
    expect(keyOf(req({ 'x-report-key': 'guess', 'x-assistant-user': 'user_a' }))).toMatch(/^finance:ip:/);
  });
});
