import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type AppTheme = 'dark' | 'light'

interface AppState {
  language: 'en' | 'zh'
  theme: AppTheme
  setLanguage: (language: 'en' | 'zh') => void
  setTheme: (theme: AppTheme) => void
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      language: 'en',
      theme: 'light',
      setLanguage: (language) => set({ language }),
      setTheme: (theme) => set({ theme }),
    }),
    {
      name: 'app-storage',
      partialize: (state) => ({ language: state.language, theme: state.theme }),
    }
  )
)
