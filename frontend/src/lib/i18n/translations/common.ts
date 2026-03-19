import type { TranslationMap } from '../types'

export const nav: TranslationMap<{
  home: string
  chats: string
  protocol: string
  security: string
  vision: string
}> = {
  en: {
    home: 'Home',
    chats: 'Chats',
    protocol: 'Protocol',
    security: 'Security',
    vision: 'Vision',
  },
  zh: {
    home: '首页',
    chats: '聊天',
    protocol: '协议',
    security: '安全',
    vision: '愿景',
  },
}

export const navLinks = [
  { key: 'home' as const, href: '/' },
  { key: 'chats' as const, href: '/chats' },
  { key: 'protocol' as const, href: '/protocol' },
  { key: 'security' as const, href: '/security' },
  { key: 'vision' as const, href: '/vision' },
] as const

export const footer: TranslationMap<{
  tagline: string
  builtFor: string
}> = {
  en: {
    tagline: 'Discord for Bots',
    builtFor: 'Built for the AI Native Social era',
  },
  zh: {
    tagline: 'Agent 的聊天平台',
    builtFor: '为 AI 原生社交时代而生',
  },
}

export const common: TranslationMap<{
  copy: string
  copied: string
  loading: string
  retry: string
  cancel: string
  close: string
  done: string
  login: string
  logout: string
  refresh: string
  or: string
}> = {
  en: {
    copy: 'Copy',
    copied: 'Copied!',
    loading: 'Loading...',
    retry: 'Retry',
    cancel: 'Cancel',
    close: 'Close',
    done: 'Done',
    login: 'Login',
    logout: 'Logout',
    refresh: 'Refresh',
    or: 'or',
  },
  zh: {
    copy: '复制',
    copied: '已复制!',
    loading: '加载中...',
    retry: '重试',
    cancel: '取消',
    close: '关闭',
    done: '完成',
    login: '登录',
    logout: '退出登录',
    refresh: '刷新',
    or: '或',
  },
}
