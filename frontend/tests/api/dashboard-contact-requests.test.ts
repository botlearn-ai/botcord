import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from '../../src/app/api/dashboard/contact-requests/route';
import { NextResponse } from 'next/server';

const { mockResults, createMockChain } = vi.hoisted(() => {
  const mockResults = {
    agents: [] as any[],
    contacts: [] as any[],
    contactRequests: [] as any[],
    inserted: [] as any[],
    created: [] as any[],
  };

  const createMockChain = (type: string) => {
    return {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockImplementation(() => {
        if (type === 'agents') return Promise.resolve(mockResults.agents);
        if (type === 'contacts') return Promise.resolve(mockResults.contacts);
        if (type === 'contactRequests') return Promise.resolve(mockResults.contactRequests);
        if (type === 'created') return Promise.resolve(mockResults.created);
        return Promise.resolve([]);
      }),
      insert: vi.fn().mockReturnThis(),
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockImplementation(() => Promise.resolve(mockResults.inserted)),
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
    };
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

// Mock drizzle-orm functions
vi.mock('drizzle-orm', () => ({
  and: vi.fn(),
  eq: vi.fn(),
}));

// Mock schema
vi.mock('@/../db/schema', () => ({
  agents: { agentId: 'agentId', displayName: 'displayName' },
  contacts: { id: 'id', ownerId: 'ownerId', contactAgentId: 'contactAgentId' },
  contactRequests: { id: 'id', fromAgentId: 'fromAgentId', toAgentId: 'toAgentId', state: 'state', message: 'message', createdAt: 'createdAt', resolvedAt: 'resolvedAt' },
}));

vi.mock('@/../db/backend', () => {
  return {
    backendDb: {
      select: vi.fn((fields) => {
        // Just return a chain that resolves an empty array by default, or the mocked results if matched by type.
        // It's hard to distinguish based on `fields` because it's called with schema fields. 
        // We can just inspect the returned value later, but here we can just do:
        if (fields.agentId) return createMockChain('agents');
        if (fields.id && !fields.state && !fields.fromAgentId) return createMockChain('contacts');
        if (fields.state && !fields.fromAgentId) return createMockChain('contactRequests');
        if (fields.fromAgentId) return createMockChain('created');
        return createMockChain('unknown');
      }),
      insert: vi.fn().mockReturnValue(createMockChain('insert')),
      update: vi.fn().mockReturnValue(createMockChain('update')),
    },
  };
});

import { requireAgent } from '@/lib/require-agent';

describe('POST /api/dashboard/contact-requests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResults.agents = [];
    mockResults.contacts = [];
    mockResults.contactRequests = [];
    mockResults.inserted = [];
    mockResults.created = [];
  });

  const createMockRequest = (body: any) => ({
    json: vi.fn().mockResolvedValue(body),
  } as any);

  it('returns error if requireAgent fails', async () => {
    vi.mocked(requireAgent).mockResolvedValueOnce({
      error: { message: 'Unauthorized', status: 401 }
    } as any);

    const response = await POST(createMockRequest({}));
    expect(response).toEqual({ data: { error: 'Unauthorized' }, status: 401 });
  });

  it('returns error if to_agent_id is missing', async () => {
    vi.mocked(requireAgent).mockResolvedValueOnce({ agentId: 'agent-1' } as any);

    const response = await POST(createMockRequest({}));
    expect(response).toEqual({ data: { error: 'to_agent_id is required' }, status: 400 });
  });

  it('returns error if sending request to self', async () => {
    vi.mocked(requireAgent).mockResolvedValueOnce({ agentId: 'agent-1' } as any);

    const response = await POST(createMockRequest({ to_agent_id: 'agent-1' }));
    expect(response).toEqual({ data: { error: 'Cannot send contact request to yourself' }, status: 400 });
  });

  it('returns error if target agent not found', async () => {
    vi.mocked(requireAgent).mockResolvedValueOnce({ agentId: 'agent-1' } as any);
    mockResults.agents = [];

    const response = await POST(createMockRequest({ to_agent_id: 'agent-2' }));
    expect(response).toEqual({ data: { error: 'Target agent not found' }, status: 404 });
  });

  it('creates a new contact request successfully', async () => {
    vi.mocked(requireAgent).mockResolvedValueOnce({ agentId: 'agent-1' } as any);
    mockResults.agents = [{ agentId: 'agent-2', displayName: 'Target Agent' }] as any;
    mockResults.contacts = [];
    mockResults.contactRequests = [];
    mockResults.inserted = [{ id: 'req-1' }] as any;
    mockResults.created = [{
      id: 'req-1',
      fromAgentId: 'agent-1',
      toAgentId: 'agent-2',
      state: 'pending',
      message: 'Hello',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      resolvedAt: null,
    }] as any;

    const response = await POST(createMockRequest({ to_agent_id: 'agent-2', message: 'Hello' }));
    
    expect(response.status).toBe(201);
    expect(response.data.id).toBe('req-1');
    expect(response.data.state).toBe('pending');
    expect(response.data.to_display_name).toBe('Target Agent');
  });
});
