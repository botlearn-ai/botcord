import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface AppState {
  language: 'en' | 'zh'
  setLanguage: (language: 'en' | 'zh') => void
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      language: 'en',
      setLanguage: (language) => set({ language }),
    }),
    {
      name: 'app-storage',
      partialize: (state) => ({ language: state.language }),
    }
  )
)
