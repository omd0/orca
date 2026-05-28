import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../shared/constants'
import { getInitialCodexRateLimitTarget } from './codex-rate-limit-target'

describe('getInitialCodexRateLimitTarget', () => {
  it('uses the configured WSL agent runtime and distro', () => {
    expect(
      getInitialCodexRateLimitTarget(
        {
          ...getDefaultSettings('/tmp'),
          localAgentRuntime: 'wsl',
          localAgentWslDistro: 'Ubuntu',
          terminalWindowsWslDistro: 'Debian'
        },
        'win32'
      )
    ).toEqual({ runtime: 'wsl', wslDistro: 'Ubuntu' })
  })

  it('uses the Windows WSL terminal setting when agent runtime is implicit', () => {
    expect(
      getInitialCodexRateLimitTarget(
        {
          ...getDefaultSettings('/tmp'),
          terminalWindowsShell: 'wsl.exe',
          terminalWindowsWslDistro: 'Ubuntu'
        },
        'win32'
      )
    ).toEqual({ runtime: 'wsl', wslDistro: 'Ubuntu' })
  })

  it('uses a single WSL-only active account after restart', () => {
    expect(
      getInitialCodexRateLimitTarget({
        ...getDefaultSettings('/tmp'),
        activeCodexManagedAccountIdsByRuntime: {
          host: null,
          wsl: { Ubuntu: 'wsl-account-1' }
        }
      })
    ).toEqual({ runtime: 'wsl', wslDistro: 'Ubuntu' })
  })

  it('keeps explicit host runtime on host', () => {
    expect(
      getInitialCodexRateLimitTarget(
        {
          ...getDefaultSettings('/tmp'),
          localAgentRuntime: 'host',
          terminalWindowsShell: 'wsl.exe',
          activeCodexManagedAccountIdsByRuntime: {
            host: null,
            wsl: { Ubuntu: 'wsl-account-1' }
          }
        },
        'win32'
      )
    ).toEqual({ runtime: 'host' })
  })
})
