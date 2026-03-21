import { describe, it, expect, vi } from 'vitest';
import { GET } from '../../src/app/api/users/me/route';
import { NextResponse } from 'next/server';

// Mock next/server
vi.mock('next/server', () => ({
  NextResponse: {
    json: vi.fn((data, options) => ({
      data,
      status: options?.status || 200,
    })),
  },
}));

// Mock requireAuth
vi.mock('@/lib/auth', () => ({
  requireAuth: vi.fn(),
}));

import { requireAuth } from '@/lib/auth';

describe('GET /api/users/me', () => {
  it('returns 401 when not authenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({
      error: { message: 'Unauthorized', status: 401 },
    });

    const response = await GET();
    
    expect(response).toEqual({
      data: { error: 'Unauthorized' },
      status: 401,
    });
  });

  it('returns user data when authenticated', async () => {
    const mockUser = {
      id: 'user-1',
      displayName: 'Test User',
      email: 'test@example.com',
      avatarUrl: 'https://example.com/avatar.png',
      status: 'active',
      maxAgents: 5,
      roles: ['user'],
      agents: [
        {
          agentId: 'agent-1',
          displayName: 'Test Agent',
          isDefault: true,
          claimedAt: new Date('2026-01-01T00:00:00Z'),
        },
      ],
    };

    vi.mocked(requireAuth).mockResolvedValueOnce({
      user: mockUser,
      error: null,
    });

    const response = await GET();

    expect(response).toEqual({
      data: {
        id: mockUser.id,
        display_name: mockUser.displayName,
        email: mockUser.email,
        avatar_url: mockUser.avatarUrl,
        status: mockUser.status,
        max_agents: mockUser.maxAgents,
        roles: mockUser.roles,
        agents: [
          {
            agent_id: mockUser.agents[0].agentId,
            display_name: mockUser.agents[0].displayName,
            is_default: mockUser.agents[0].isDefault,
            claimed_at: mockUser.agents[0].claimedAt.toISOString(),
          },
        ],
      },
      status: 200,
    });
  });
});
