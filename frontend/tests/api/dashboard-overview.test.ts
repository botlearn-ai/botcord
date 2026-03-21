import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from '../../src/app/api/dashboard/overview/route';
import { NextResponse } from 'next/server';

const { mockResults, createMockChain } = vi.hoisted(() => {
  const mockResults = {
    profile: [] as any[],
    roomRows: [] as any[],
    contactList: [] as any[],
    pendingCount: [] as any[],
  };

  const createMockChain = (type: string) => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      leftJoin: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      groupBy: vi.fn().mockReturnThis(),
      as: vi.fn().mockReturnThis(),
      limit: vi.fn().mockImplementation(() => {
        if (type === 'profile') return Promise.resolve(mockResults.profile);
        return Promise.resolve([]);
      }),
      then: function(resolve: any) {
        if (type === 'memberRooms') resolve(mockResults.roomRows);
        else if (type === 'contactList') resolve(mockResults.contactList);
        else if (type === 'pendingCount') resolve(mockResults.pendingCount);
        else resolve([]);
      }
    };
    chain.select.mockReturnValue(chain);
    chain.from.mockReturnValue(chain);
    chain.where.mockReturnValue(chain);
    chain.innerJoin.mockReturnValue(chain);
    chain.leftJoin.mockReturnValue(chain);
    chain.orderBy.mockReturnValue(chain);
    chain.groupBy.mockReturnValue(chain);
    chain.as.mockReturnValue(chain);
    return chain;
  };

  return { mockResults, createMockChain };
});

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

vi.mock('@/app/api/_helpers', () => ({
  extractTextFromEnvelope: vi.fn(() => ({ text: 'hello' })),
}));

// Mock drizzle-orm functions
vi.mock('drizzle-orm', () => ({
  and: vi.fn(),
  eq: vi.fn(),
  count: vi.fn(),
  desc: vi.fn(),
  inArray: vi.fn(),
  sql: vi.fn((strings, ...values) => ({ as: vi.fn() })),
}));

// Mock schema
vi.mock('@/../db/schema', () => ({
  agents: { agentId: 'agentId', displayName: 'displayName', bio: 'bio', messagePolicy: 'messagePolicy', createdAt: 'createdAt' },
  rooms: { roomId: 'roomId', name: 'name', description: 'description', rule: 'rule', ownerId: 'ownerId', visibility: 'visibility' },
  roomMembers: { roomId: 'roomId', role: 'role', joinedAt: 'joinedAt', agentId: 'agentId' },
  contacts: { id: 'id', ownerId: 'ownerId', contactAgentId: 'contactAgentId', alias: 'alias', createdAt: 'createdAt' },
  contactRequests: { id: 'id', fromAgentId: 'fromAgentId', toAgentId: 'toAgentId', state: 'state' },
  messageRecords: { roomId: 'roomId', senderId: 'senderId', envelopeJson: 'envelopeJson', createdAt: 'createdAt' },
}));

vi.mock('@/../db/backend', () => {
  return {
    backendDb: {
      execute: vi.fn(() => Promise.resolve(mockResults.roomRows)),
      select: vi.fn((fields) => {
        if ('agentId' in fields && 'bio' in fields) return createMockChain('profile');
        if ('count' in fields && !('roomId' in fields)) return createMockChain('pendingCount');
        if ('contactAgentId' in fields) return createMockChain('contactList');
        return createMockChain('unknown');
      }),
    },
  };
});

import { requireAgent } from '@/lib/require-agent';

describe('GET /api/dashboard/overview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResults.profile = [];
    mockResults.roomRows = [];
    mockResults.contactList = [];
    mockResults.pendingCount = [];
  });

  it('returns error if requireAgent fails', async () => {
    vi.mocked(requireAgent).mockResolvedValueOnce({
      error: { message: 'Unauthorized', status: 401 }
    } as any);

    const response = await GET();
    expect(response).toEqual({ data: { error: 'Unauthorized' }, status: 401 });
  });

  it('returns 404 if agent not found in backend', async () => {
    vi.mocked(requireAgent).mockResolvedValueOnce({ agentId: 'agent-1' } as any);
    mockResults.profile = [];

    const response = await GET();
    expect(response).toEqual({ data: { error: 'Agent not found in backend' }, status: 404 });
  });

  it('returns agent overview successfully', async () => {
    vi.mocked(requireAgent).mockResolvedValueOnce({ agentId: 'agent-1' } as any);
    mockResults.profile = [{
      agentId: 'agent-1',
      displayName: 'Test Agent',
      bio: 'Hello',
      messagePolicy: 'everyone',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    }];
    mockResults.roomRows = [{
      room_id: 'room-1',
      room_name: 'Test Room',
      room_description: 'Room description',
      room_rule: 'rule1',
      required_subscription_product_id: null,
      owner_id: 'owner-1',
      visibility: 'public',
      my_role: 'member',
      member_count: 5,
      last_message_preview: 'hello',
      last_message_at: '2026-01-03T00:00:00.000Z',
      last_sender_name: 'Sender Agent',
    }];
    mockResults.contactList = [{
      contactAgentId: 'agent-2',
      alias: 'Friend',
      createdAt: new Date('2026-01-04T00:00:00Z'),
      displayName: 'Friend Agent',
      bio: 'Hi',
    }];
    mockResults.pendingCount = [{ count: 2 }];

    const response = await GET();
    
    expect(response.status).toBe(200);
    expect(response.data.agent.agent_id).toBe('agent-1');
    expect(response.data.rooms.length).toBe(1);
    expect(response.data.rooms[0].room_id).toBe('room-1');
    expect(response.data.rooms[0].member_count).toBe(5);
    expect(response.data.rooms[0].last_message_preview).toBe('hello');
    expect(response.data.contacts.length).toBe(1);
    expect(response.data.contacts[0].contact_agent_id).toBe('agent-2');
    expect(response.data.pending_requests).toBe(2);
  });
});
