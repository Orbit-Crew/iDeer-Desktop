// Reduced from linz uiStore: no persisted workspace, model or tool state.
import { create } from 'zustand'

interface UIState {
  leftPanelOpen: boolean
  toggleLeftPanel(): void
}

export const useUIStore = create<UIState>((set) => ({
  leftPanelOpen: true,
  toggleLeftPanel: () => set((state) => ({ leftPanelOpen: !state.leftPanelOpen }))
}))
