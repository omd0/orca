import { ipcMain } from 'electron'
import type { CodexAccountAddTarget, CodexAccountService } from '../codex-accounts/service'
import type { CodexAccountSelectionTarget } from '../codex-accounts/runtime-selection'

export function registerCodexAccountHandlers(codexAccounts: CodexAccountService): void {
  ipcMain.handle('codexAccounts:list', () => codexAccounts.listAccounts())
  ipcMain.handle('codexAccounts:add', (_event, args?: CodexAccountAddTarget) =>
    codexAccounts.addAccount(args)
  )
  ipcMain.handle('codexAccounts:reauthenticate', (_event, args: { accountId: string }) =>
    codexAccounts.reauthenticateAccount(args.accountId)
  )
  ipcMain.handle('codexAccounts:remove', (_event, args: { accountId: string }) =>
    codexAccounts.removeAccount(args.accountId)
  )
  ipcMain.handle(
    'codexAccounts:select',
    (_event, args: { accountId: string | null } & CodexAccountSelectionTarget) =>
      codexAccounts.selectAccountForTarget(args.accountId, args)
  )
}
