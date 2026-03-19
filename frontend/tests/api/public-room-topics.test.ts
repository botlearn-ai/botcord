import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "../../src/app/api/public/rooms/[roomId]/topics/route";

const { mockResults, createChain } = vi.hoisted(() => {
  const mockResults = {
    room: [] as any[],
    topics: [] as any[],
  };

  const createChain = (type: "room" | "topics") => ({
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockImplementation(() => Promise.resolve(mockResults[type])),
    orderBy: vi.fn().mockImplementation(() => Promise.resolve(mockResults[type])),
    then: (resolve: (value: any[]) => void) => resolve(mockResults[type]),
  });

  return { mockResults, createChain };
});

vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn((data, options) => ({
      data,
      status: options?.status || 200,
    })),
  },
}));

vi.mock("@/../db/backend", () => ({
  backendDb: {
    select: vi.fn((fields) => {
      if ("visibility" in fields) return createChain("room");
      if ("topicId" in fields) return createChain("topics");
      throw new Error("Unexpected select");
    }),
  },
}));

vi.mock("@/../db/backend-schema", () => ({
  rooms: {
    visibility: "visibility",
    roomId: "room_id",
  },
  topics: {
    topicId: "topic_id",
    roomId: "room_id",
    title: "title",
    description: "description",
    status: "status",
    creatorId: "creator_id",
    goal: "goal",
    messageCount: "message_count",
    createdAt: "created_at",
    updatedAt: "updated_at",
    closedAt: "closed_at",
  },
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args) => args),
  desc: vi.fn((arg) => arg),
  eq: vi.fn((left, right) => ({ left, right })),
}));

describe("GET /api/public/rooms/[roomId]/topics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResults.room = [];
    mockResults.topics = [];
  });

  it("returns topics for public rooms", async () => {
    mockResults.room = [{ visibility: "public" }];
    mockResults.topics = [
      {
        topicId: "tp_1",
        roomId: "room_1",
        title: "General",
        description: "Discuss things",
        status: "open",
        creatorId: "ag_1",
        goal: "Read",
        messageCount: 3,
        createdAt: new Date("2026-03-18T00:00:00Z"),
        updatedAt: new Date("2026-03-19T00:00:00Z"),
        closedAt: null,
      },
    ];

    const response = await GET({} as NextRequest, {
      params: Promise.resolve({ roomId: "room_1" }),
    } as any);

    expect(response.status).toBe(200);
    expect(response.data.topics).toHaveLength(1);
    expect(response.data.topics[0]).toMatchObject({
      topic_id: "tp_1",
      room_id: "room_1",
      title: "General",
      message_count: 3,
    });
  });

  it("rejects private rooms", async () => {
    mockResults.room = [{ visibility: "private" }];

    const response = await GET({} as NextRequest, {
      params: Promise.resolve({ roomId: "room_2" }),
    } as any);

    expect(response.status).toBe(403);
    expect(response.data.error).toBe("Room is not public");
  });
});
