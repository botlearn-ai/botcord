-- Migration: Add Topic entity and topic_id to message_records
-- Phase 1: Create topics table

CREATE TABLE IF NOT EXISTS topics (
    id SERIAL PRIMARY KEY,
    topic_id VARCHAR(32) NOT NULL UNIQUE,
    room_id VARCHAR(64) NOT NULL REFERENCES rooms(room_id),
    title VARCHAR(256) NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status VARCHAR(16) NOT NULL DEFAULT 'open',
    creator_id VARCHAR(32) NOT NULL REFERENCES agents(agent_id),
    goal VARCHAR(1024),
    message_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    closed_at TIMESTAMPTZ,
    CONSTRAINT uq_topic_room_title UNIQUE (room_id, title)
);

CREATE INDEX IF NOT EXISTS ix_topics_topic_id ON topics(topic_id);
CREATE INDEX IF NOT EXISTS ix_topics_room_id ON topics(room_id);
CREATE INDEX IF NOT EXISTS ix_topics_creator_id ON topics(creator_id);

-- Phase 2: Add topic_id column to message_records

ALTER TABLE message_records ADD COLUMN IF NOT EXISTS topic_id VARCHAR(32);
CREATE INDEX IF NOT EXISTS ix_message_records_topic_id ON message_records(topic_id);

-- Phase 3: Data migration — create Topic entities from existing (room_id, topic) pairs
-- Uses a generated topic_id based on 'tp_' prefix + random hex

INSERT INTO topics (topic_id, room_id, title, description, status, creator_id, message_count, created_at, updated_at)
SELECT
    'tp_' || substr(md5(random()::text), 1, 12) AS topic_id,
    agg.room_id,
    agg.topic AS title,
    '' AS description,
    'open' AS status,
    first_sender.sender_id AS creator_id,
    agg.msg_count AS message_count,
    agg.min_created AS created_at,
    agg.max_created AS updated_at
FROM (
    SELECT room_id, topic,
           COUNT(*) AS msg_count,
           MIN(created_at) AS min_created,
           MAX(created_at) AS max_created
    FROM message_records
    WHERE room_id IS NOT NULL AND topic IS NOT NULL
    GROUP BY room_id, topic
) agg
JOIN LATERAL (
    SELECT sender_id FROM message_records
    WHERE room_id = agg.room_id AND topic = agg.topic
    ORDER BY created_at ASC
    LIMIT 1
) first_sender ON true
ON CONFLICT (room_id, title) DO NOTHING;

-- Phase 4: Backfill topic_id on message_records from topics table

UPDATE message_records mr
SET topic_id = t.topic_id
FROM topics t
WHERE mr.room_id = t.room_id
  AND mr.topic = t.title
  AND mr.topic_id IS NULL;
