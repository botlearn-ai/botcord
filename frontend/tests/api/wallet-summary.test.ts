import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from '../../src/app/api/wallet/summary/route';
import { NextResponse } from 'next/server';

vi.mock('next/server', () => ({
  NextResponse: {
    json: vi.fn((data, options) => ({
      data,
      status: options?.status || 200,
    })),
  },
}));

vi.mock('@/lib/require-agent', () => ({
  requireAgent: vi.fn(),
}));

vi.mock('@/lib/services/wallet', () => ({
  getWalletSummary: vi.fn(),
}));

import { requireAgent } from '@/lib/require-agent';
import { getWalletSummary } from '@/lib/services/wallet';

describe('GET /api/wallet/summary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns error if requireAgent fails', async () => {
    vi.mocked(requireAgent).mockResolvedValueOnce({
      error: { message: 'Unauthorized', status: 401 }
    } as any);

    const response = await GET() as any;

    expect(response.status).toBe(401);
    expect(response.data).toEqual({ error: 'Unauthorized' });
  });

  it('returns wallet summary successfully', async () => {
    vi.mocked(requireAgent).mockResolvedValueOnce({ agentId: 'agent-1' } as any);
    
    const mockSummary = {
      balance: 1000,
      currency: 'COIN',
      recentTransactions: [],
    };
    
    vi.mocked(getWalletSummary).mockResolvedValueOnce(mockSummary as any);

    const response = await GET() as any;

    expect(response.status).toBe(200);
    expect(response.data).toEqual(mockSummary);
    expect(getWalletSummary).toHaveBeenCalledWith('agent-1');
  });
});
