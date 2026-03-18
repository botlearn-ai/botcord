'use client'

import { usePathname } from 'next/navigation'
import { useAppStore } from '@/store/useAppStore'
import type { Locale } from './types'

export * from './types'
export * from './translations'

/**
 * Resolve locale from path and store.
 * - Path /zh, /zh/* -> 'zh'
 * - Path /en, /en/* -> 'en'
 * - Path /, /chats, etc -> use store language
 */
export function useLanguage(): Locale {
  const pathname = usePathname()
  const { language: storeLanguage } = useAppStore()

  const pathLocale: Locale | null = pathname?.startsWith('/zh')
    ? 'zh'
    : pathname?.startsWith('/en')
      ? 'en'
      : null

  return pathLocale ?? storeLanguage ?? 'en'
}
