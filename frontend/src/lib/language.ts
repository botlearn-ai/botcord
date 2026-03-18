/**
 * Get language from route path
 * @param path - The route path (e.g., '/zh/getting-started' or '/en/faq')
 * @returns 'zh' if path starts with '/zh', otherwise 'en'
 */
export function getLanguageFromRoute(path: string): 'en' | 'zh' {
  return path.startsWith('/zh') ? 'zh' : 'en'
}
