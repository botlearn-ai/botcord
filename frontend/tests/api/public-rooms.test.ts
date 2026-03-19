import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from '../../src/app/api/public/rooms/route';
import { NextRequest } from 'next/server';

const { mockResults, createMockChain } = vi.hoisted(() => {
  const mockResults = {
    count: [] as any[],
    roomList: [] as any[],
    lastMsg: [] as any[],
  };

  const createMockChain = (type: string) => {
    return {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      leftJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      groupBy: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      offset: vi.fn().mockImplementation(() => {
        if (type === 'roomList') return Promise.resolve(mockResults.roomList);
        return Promise.resolve([]);
      }),
      then: function(resolve: any) {
        if (type === 'count') resolve(mockResults.count);
        else if (type === 'lastMsg') resolve(mockResults.lastMsg);
        else resolve([]);
      }
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

vi.mock('@/../db/backend', () => ({
  isBackendDbConfigured: true,
  backendDbConfigError: 'DB not configured',
  backendDb: {
    select: vi.fn((fields) => {
      if ('count' in fields && !('roomId' in fields)) return createMockChain('count');
      if ('roomId' in fields && 'ownerId' in fields) return createMockChain('roomList');
      if ('msgId' in fields && 'envelopeJson' in fields) return createMockChain('lastMsg');
      return createMockChain('unknown');
    }),
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  count: vi.fn(),
  desc: vi.fn(),
  ilike: vi.fn(),
  and: vi.fn((...args) => args),
}));

vi.mock('@/app/api/_helpers', () => ({
  extractTextFromEnvelope: vi.fn(() => ({ text: 'hello message text' })),
  escapeLike: vi.fn((str) => str),
}));

describe('GET /api/public/rooms', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResults.count = [];
    mockResults.roomList = [];
    mockResults.lastMsg = [];
  });

  const createRequest = (url: string) => {
    return {
      nextUrl: new URL(url),
    } as unknown as NextRequest;
  };

  it('returns public rooms correctly', async () => {
    mockResults.count = [{ count: 1 }];
    mockResults.roomList = [{
      roomId: 'room-1',
      name: 'Public Room',
      description: 'A test public room',
      ownerId: 'owner-1',
      visibility: 'public',
      joinPolicy: 'open',
      maxMembers: 100,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      memberCount: 5,
    }];
    mockResults.lastMsg = [{
      msgId: 'msg-1',
      senderId: 'user-1',
      envelopeJson: '{"text": "hello"}',
      createdAt: new Date('2026-01-02T00:00:00Z'),
    }];

    const req = createRequest('http://localhost:3000/api/public/rooms?q=test&limit=10&offset=0');
    const response = await GET(req) as any;

    expect(response.status).toBe(200);
    expect(response.data.total).toBe(1);
    expect(response.data.limit).toBe(10);
    expect(response.data.offset).toBe(0);
    expect(response.data.rooms.length).toBe(1);
    expect(response.data.rooms[0].room_id).toBe('room-1');
    expect(response.data.rooms[0].last_message.text).toBe('hello message text');
  });
});
