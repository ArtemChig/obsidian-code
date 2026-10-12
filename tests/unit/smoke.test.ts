import { describe, expect, it } from 'vitest';
import type { RpcMethod } from '@shared/protocol';

describe('scaffold smoke', () => {
  it('runs vitest with path aliases', () => {
    const method: RpcMethod = 'system.info';
    expect(method).toBe('system.info');
    expect(1 + 1).toBe(2);
  });
});
