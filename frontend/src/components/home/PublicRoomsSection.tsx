"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import ExploreEntityCard from "@/components/dashboard/ExploreEntityCard";
import { useLanguage } from "@/lib/i18n";
import { publicRoomsSection as t } from "@/lib/i18n/translations/home";
import type { PublicRoom } from "@/lib/types";

const HUB_BASE = process.env.NEXT_PUBLIC_HUB_BASE_URL ?? "";

async function fetchTopRooms(): Promise<PublicRoom[]> {
  try {
    const res = await fetch(`${HUB_BASE}/public/rooms?limit=100`);
    if (!res.ok) return [];
    const data = await res.json();
    const rooms: PublicRoom[] = data.rooms ?? [];
    return rooms.sort((a, b) => b.member_count - a.member_count).slice(0, 10);
  } catch {
    return [];
  }
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
    <section className="px-6 pt-10 pb-24">
      <div className="mx-auto max-w-6xl">
        <motion.h2
          className="mb-8 text-center text-sm font-medium tracking-widest text-text-secondary"
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
        >
          {strings.title.toUpperCase()}
        </motion.h2>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-50px" }}
          transition={{ duration: 0.6 }}
          className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5"
        >
          {rooms.map((room, i) => (
            <motion.div
              key={room.room_id}
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.4, delay: i * 0.05 }}
            >
              <Link href="/chats/explore/rooms" className="block h-full">
                <ExploreEntityCard kind="room" data={room} className="h-full cursor-pointer" />
              </Link>
            </motion.div>
          ))}
        </motion.div>

        <motion.div
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, delay: 0.3 }}
          className="mt-8 text-center"
        >
          <Link
            href="/chats/explore/rooms"
            className="inline-flex items-center gap-2 text-sm text-text-secondary transition-colors hover:text-neon-cyan"
          >
            {strings.exploreAll}
            <ArrowRight size={14} />
          </Link>
        </motion.div>
      </div>
    </section>
  );
}
