import type { StateCreator } from 'zustand'
import type { RateLimitRuntimeTarget, RateLimitState } from '../../../../shared/rate-limit-types'
import type { AppState } from '../types'

export type RateLimitSlice = {
  rateLimits: RateLimitState
  fetchRateLimits: () => Promise<void>
  refreshRateLimits: () => Promise<void>
  refreshCodexRateLimitsForTarget: (target: RateLimitRuntimeTarget) => Promise<void>
  fetchInactiveClaudeAccountUsage: () => Promise<void>
  fetchInactiveCodexAccountUsage: () => Promise<void>
  setRateLimitsFromPush: (state: RateLimitState) => void
}

export const createRateLimitSlice: StateCreator<AppState, [], [], RateLimitSlice> = (set) => ({
  rateLimits: {
    claude: null,
    codex: null,
    gemini: null,
    opencodeGo: null,
    codexTarget: { runtime: 'host', wslDistro: null },
    inactiveClaudeAccounts: [],
    inactiveCodexAccounts: []
  },

  fetchRateLimits: async () => {
    try {
      const state = await window.api.rateLimits.get()
      set({ rateLimits: state })
    } catch (error) {
      console.error('Failed to fetch rate limits:', error)
    }
  },

  refreshRateLimits: async () => {
    try {
      const state = await window.api.rateLimits.refresh()
      set({ rateLimits: state })
    } catch (error) {
      console.error('Failed to refresh rate limits:', error)
    }
  },

  refreshCodexRateLimitsForTarget: async (target) => {
    try {
      const state = await window.api.rateLimits.refreshCodexForTarget(target)
      set({ rateLimits: state })
    } catch (error) {
      console.error('Failed to refresh Codex usage for runtime:', error)
    }
  },

  fetchInactiveClaudeAccountUsage: async () => {
    try {
      await window.api.rateLimits.fetchInactiveClaudeAccounts()
    } catch (error) {
      console.error('Failed to fetch inactive Claude account usage:', error)
    }
  },

  fetchInactiveCodexAccountUsage: async () => {
    try {
      await window.api.rateLimits.fetchInactiveCodexAccounts()
    } catch (error) {
      console.error('Failed to fetch inactive Codex account usage:', error)
    }
  },

  setRateLimitsFromPush: (state) => {
    set({ rateLimits: state })
  }
})
