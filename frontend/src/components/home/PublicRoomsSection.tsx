"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import Link from "next/link";
import { Users, MessageSquare, ArrowRight } from "lucide-react";
import SectionHeading from "@/components/ui/SectionHeading";
import { useLanguage } from "@/lib/i18n";
import { publicRoomsSection as t } from "@/lib/i18n/translations/home";
import type { PublicRoom } from "@/lib/types";

const HUB_BASE = process.env.NEXT_PUBLIC_HUB_BASE_URL ?? "";

async function fetchTopRooms(): Promise<PublicRoom[]> {
  const url = `${HUB_BASE}/public/rooms?limit=100`;
  const res = await fetch(url, { next: { revalidate: 60 } } as RequestInit);
  if (!res.ok) return [];
  const data = await res.json();
  const rooms: PublicRoom[] = data.rooms ?? [];
  return rooms
    .sort((a, b) => b.member_count - a.member_count)
    .slice(0, 10);
}

export default function PublicRoomsSection() {
  const locale = useLanguage();
  const strings = t[locale];
  const [rooms, setRooms] = useState<PublicRoom[]>([]);

  useEffect(() => {
    fetchTopRooms().then(setRooms);
  }, []);

  if (rooms.length === 0) return null;

  return (
    <section className="px-6 py-24">
      <div className="mx-auto max-w-6xl">
        <SectionHeading
          title={strings.title}
          subtitle={strings.subtitle}
          accentColor="purple"
        />

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          {rooms.map((room, i) => (
            <motion.div
              key={room.room_id}
              initial={{ opacity: 0, y: 24 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-40px" }}
              transition={{ duration: 0.5, delay: i * 0.06 }}
            >
              <Link
                href="/chats/explore/rooms"
                className="group flex h-full flex-col rounded-2xl border border-glass-border bg-glass-bg p-5 backdrop-blur-xl transition-all duration-300 hover:border-neon-purple/30 hover:shadow-[0_0_28px_rgba(139,92,246,0.12)]"
              >
                <div className="mb-3 flex items-start justify-between gap-2">
                  <h3 className="line-clamp-1 text-sm font-semibold text-white group-hover:text-neon-purple transition-colors duration-200">
                    {room.name}
                  </h3>
                  <span className="flex shrink-0 items-center gap-1 rounded-full bg-neon-purple/10 px-2 py-0.5 text-xs text-neon-purple">
                    <Users size={10} />
                    {room.member_count}
                  </span>
                </div>

                {room.description && (
                  <p className="mb-3 line-clamp-2 flex-1 text-xs leading-relaxed text-text-secondary">
                    {room.description}
                  </p>
                )}

                {room.last_message_preview && (
                  <div className="mt-auto flex items-start gap-1.5 rounded-lg bg-white/[0.03] p-2">
                    <MessageSquare size={10} className="mt-0.5 shrink-0 text-neon-cyan/60" />
                    <p className="line-clamp-2 text-xs text-text-secondary/70">
                      {room.last_sender_name && (
                        <span className="font-medium text-neon-cyan/80">{room.last_sender_name}: </span>
                      )}
                      {room.last_message_preview}
                    </p>
                  </div>
                )}
              </Link>
            </motion.div>
          ))}
        </div>

        <motion.div
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, delay: 0.4 }}
          className="mt-10 text-center"
        >
          <Link
            href="/chats/explore/rooms"
            className="inline-flex items-center gap-2 rounded-full border border-neon-purple/30 bg-neon-purple/10 px-6 py-2.5 text-sm font-medium text-neon-purple transition-all duration-200 hover:bg-neon-purple/20 hover:shadow-[0_0_20px_rgba(139,92,246,0.2)]"
          >
            {strings.exploreAll}
            <ArrowRight size={14} />
          </Link>
        </motion.div>
      </div>
    </section>
  );
}
