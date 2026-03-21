import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from '../../src/app/api/public/rooms/route';
import { NextRequest } from 'next/server';

const { mockResults, createMockChain } = vi.hoisted(() => {
  const mockResults = {
    count: [] as any[],
    roomRows: [] as any[],
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
      offset: vi.fn().mockReturnThis(),
      then: function(resolve: any) {
        if (type === 'count') resolve(mockResults.count);
        else resolve([]);
      }
    };
  };

  return { mockResults, createMockChain };
});

const backendFlags = vi.hoisted(() => ({
  isConfigured: true,
}));

vi.mock('next/server', () => ({
  NextResponse: {
    json: vi.fn((data, options) => ({
      data,
      status: options?.status || 200,
    })),
  },
}));

vi.mock('@/../db/backend', () => ({
  get isBackendDbConfigured() {
    return backendFlags.isConfigured;
  },
  backendDbConfigError: 'DB not configured',
  backendDb: {
    execute: vi.fn(() => Promise.resolve(mockResults.roomRows)),
    select: vi.fn((fields) => {
      if ('count' in fields && !('roomId' in fields)) return createMockChain('count');
      return createMockChain('unknown');
    }),
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  count: vi.fn(),
  ilike: vi.fn(),
  and: vi.fn((...args) => args),
  sql: vi.fn((strings, ...values) => ({ strings, values })),
}));

vi.mock('@/app/api/_helpers', () => ({
  escapeLike: vi.fn((str) => str),
}));

describe('GET /api/public/rooms', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    backendFlags.isConfigured = true;
    mockResults.count = [];
    mockResults.roomRows = [];
  });

  const createRequest = (url: string) => {
    return {
      nextUrl: new URL(url),
    } as unknown as NextRequest;
  };

  it('returns public rooms correctly', async () => {
    mockResults.count = [{ count: 1 }];
    mockResults.roomRows = [{
      room_id: 'room-1',
      room_name: 'Public Room',
      room_description: 'A test public room',
      room_rule: null,
      required_subscription_product_id: null,
      owner_id: 'owner-1',
      visibility: 'public',
      join_policy: 'open',
      max_members: 100,
      created_at: '2026-01-01T00:00:00.000Z',
      member_count: 5,
      last_message_preview: 'hello message text',
      last_message_at: '2026-01-02T00:00:00.000Z',
      last_sender_name: 'user-1',
    }];

    const req = createRequest('http://localhost:3000/api/public/rooms?q=test&limit=10&offset=0');
    const response = await GET(req) as any;

    expect(response.status).toBe(200);
    expect(response.data.total).toBe(1);
    expect(response.data.limit).toBe(10);
    expect(response.data.offset).toBe(0);
    expect(response.data.rooms.length).toBe(1);
    expect(response.data.rooms[0].room_id).toBe('room-1');
    expect(response.data.rooms[0].last_message_preview).toBe('hello message text');
  });

  it('returns 503 when backend db is not configured', async () => {
    backendFlags.isConfigured = false;

    const req = createRequest('http://localhost:3000/api/public/rooms');
    const response = await GET(req) as any;

    expect(response.status).toBe(503);
    expect(response.data.error).toBe('DB not configured');
  });

  it('dedupes duplicated room_id rows from function result', async () => {
    mockResults.count = [{ count: 2 }];
    mockResults.roomRows = [
      {
        room_id: 'room-dup',
        room_name: 'Public Room',
        room_description: 'A test public room',
        room_rule: null,
        required_subscription_product_id: null,
        owner_id: 'owner-1',
        visibility: 'public',
        join_policy: 'open',
        max_members: 100,
        created_at: '2026-01-01T00:00:00.000Z',
        member_count: 5,
        last_message_preview: 'hello message text',
        last_message_at: '2026-01-02T00:00:00.000Z',
        last_sender_name: 'user-1',
      },
      {
        room_id: 'room-dup',
        room_name: 'Public Room duplicate',
        room_description: 'Dup row',
        room_rule: null,
        required_subscription_product_id: null,
        owner_id: 'owner-1',
        visibility: 'public',
        join_policy: 'open',
        max_members: 100,
        created_at: '2026-01-01T00:00:00.000Z',
        member_count: 6,
        last_message_preview: 'dup',
        last_message_at: '2026-01-02T01:00:00.000Z',
        last_sender_name: 'user-2',
      },
    ];

    const req = createRequest('http://localhost:3000/api/public/rooms');
    const response = await GET(req) as any;

    expect(response.status).toBe(200);
    expect(response.data.rooms.length).toBe(1);
    expect(response.data.rooms[0].room_id).toBe('room-dup');
  });

  it('clamps limit and offset query params to safe range', async () => {
    mockResults.count = [{ count: 0 }];
    mockResults.roomRows = [];

    const req = createRequest('http://localhost:3000/api/public/rooms?limit=999&offset=-12');
    const response = await GET(req) as any;

    expect(response.status).toBe(200);
    expect(response.data.limit).toBe(100);
    expect(response.data.offset).toBe(0);
  });
});
