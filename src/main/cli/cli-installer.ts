/* eslint-disable max-lines -- Why: this file centralizes cross-platform CLI install state, launcher resolution, and PATH registration so the public shell command stays consistent across packaged and development builds. */
import { app } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { lstat, mkdir, readFile, readlink, symlink, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { CliInstallMethod, CliInstallStatus } from '../../shared/cli-install-types'

const execFileAsync = promisify(execFile)
const DEFAULT_MAC_COMMAND_PATH = '/usr/local/bin/orca'
const DEV_LAUNCHER_DIR = ['cli', 'bin']

type CliInstallerOptions = {
  platform?: NodeJS.Platform
  isPackaged?: boolean
  userDataPath?: string
  resourcesPath?: string
  execPath?: string
  appPath?: string
  homePath?: string
  localAppDataPath?: string
  processPathEnv?: string | null
  commandPathOverride?: string | null
  privilegedRunner?: (command: string) => Promise<void>
  userPathReader?: () => Promise<string | null>
  userPathWriter?: (value: string) => Promise<void>
  // Why: AppImage runs from a FUSE mount at /tmp/.mount_*, so resourcesPath
  // is ephemeral. The CLI must use a wrapper script that references the
  // stable .AppImage file on disk instead of symlinking into the mount.
  appImagePath?: string | null
}

type InstallSpec = {
  commandPath: string
  installMethod: CliInstallMethod
}

export class CliInstaller {
  private readonly platform: NodeJS.Platform
  private readonly isPackaged: boolean
  private readonly userDataPath: string
  private readonly resourcesPath: string
  private readonly execPathValue: string
  private readonly appPathValue: string
  private readonly homePath: string
  private readonly localAppDataPath: string
  private readonly processPathEnv: string | null
  private readonly commandPathOverride: string | null
  private readonly privilegedRunner: (command: string) => Promise<void>
  private readonly userPathReader: () => Promise<string | null>
  private readonly userPathWriter: (value: string) => Promise<void>
  private readonly appImagePath: string | null

  constructor(options: CliInstallerOptions = {}) {
    this.platform = options.platform ?? process.platform
    this.isPackaged = options.isPackaged ?? app.isPackaged
    this.userDataPath = options.userDataPath ?? app.getPath('userData')
    this.resourcesPath = options.resourcesPath ?? process.resourcesPath
    this.execPathValue = options.execPath ?? process.execPath
    this.appPathValue = options.appPath ?? app.getAppPath()
    this.homePath = options.homePath ?? homedir()
    this.localAppDataPath =
      options.localAppDataPath ??
      process.env.LOCALAPPDATA ??
      join(this.homePath, 'AppData', 'Local')
    this.processPathEnv = options.processPathEnv ?? process.env.PATH ?? process.env.Path ?? null
    this.commandPathOverride =
      options.commandPathOverride ?? process.env.ORCA_CLI_INSTALL_PATH ?? null
    this.privilegedRunner = options.privilegedRunner ?? runMacPrivilegedCommand
    this.userPathReader = options.userPathReader ?? (() => readWindowsUserPath())
    this.userPathWriter = options.userPathWriter ?? ((value) => writeWindowsUserPath(value))
    this.appImagePath = options.appImagePath ?? process.env.APPIMAGE ?? null
  }

  // Why: on Linux the CLI command is `orca-ide` to avoid conflicting with
  // GNOME Orca (/usr/bin/orca). All other platforms keep `orca`.
  private get commandName(): string {
    return this.platform === 'linux' ? 'orca-ide' : 'orca'
  }

  async getStatus(): Promise<CliInstallStatus> {
    const spec = this.resolveInstallSpec()
    if (!spec) {
      return {
        platform: this.platform,
        commandName: this.commandName,
        commandPath: null,
        pathDirectory: null,
        pathConfigured: false,
        launcherPath: null,
        installMethod: null,
        supported: false,
        state: 'unsupported',
        currentTarget: null,
        unsupportedReason: 'platform_not_supported',
        detail: 'CLI registration is not implemented on this platform.'
      }
    }

    const launcherPath = await this.resolveLauncherPath()
    if (!launcherPath) {
      return {
        platform: this.platform,
        commandName: this.commandName,
        commandPath: spec.commandPath,
        pathDirectory: dirname(spec.commandPath),
        pathConfigured: false,
        launcherPath: null,
        installMethod: spec.installMethod,
        supported: false,
        state: 'unsupported',
        currentTarget: null,
        unsupportedReason: this.isPackaged ? 'launcher_missing' : 'launch_mode_unavailable',
        detail: this.isPackaged
          ? 'The bundled CLI launcher is missing from this Orca build.'
          : 'Development mode uses a generated launcher for validation only.'
      }
    }

    const baseStatus =
      spec.installMethod === 'symlink'
        ? await this.inspectSymlink(spec.commandPath, launcherPath)
        : this.appImagePath
          ? await this.inspectAppImageWrapper(spec.commandPath, this.appImagePath)
          : await this.inspectWindowsWrapper(spec.commandPath, launcherPath)
    const pathDirectory = dirname(spec.commandPath)
    const pathConfigured = await this.isPathConfigured(pathDirectory)
    return this.withPathInfo(baseStatus, pathDirectory, pathConfigured)
  }

  async install(): Promise<CliInstallStatus> {
    const status = await this.getStatus()
    if (!status.supported || !status.commandPath || !status.launcherPath || !status.installMethod) {
      throw new Error(status.detail ?? 'CLI registration is unavailable on this build.')
    }
    if (status.state === 'conflict') {
      throw new Error(`Refusing to replace non-Orca command at ${status.commandPath}.`)
    }

    await mkdir(dirname(status.commandPath), { recursive: true })

    // eslint-disable-next-line unicorn/prefer-ternary -- Why: the install path performs async side effects and is easier to audit as an explicit branch than as an awaited ternary.
    if (status.installMethod === 'symlink') {
      await this.installSymlink(status)
    } else if (this.appImagePath) {
      await this.installAppImageWrapper(status.commandPath, this.appImagePath)
    } else {
      await this.installWindowsWrapper(status.commandPath, status.launcherPath)
    }

    if (this.platform === 'win32') {
      // Why: Windows shells discover commands via the user PATH, not by walking
      // arbitrary app install directories. The CLI installer therefore owns the
      // user-scoped PATH entry instead of assuming the desktop installer did it.
      await this.ensureWindowsPathEntry(dirname(status.commandPath))
    }

    return this.getStatus()
  }

  async remove(): Promise<CliInstallStatus> {
    const status = await this.getStatus()
    if (!status.supported || !status.commandPath || !status.launcherPath || !status.installMethod) {
      return status
    }
    if (status.state === 'not_installed') {
      if (this.platform === 'win32') {
        await this.removeWindowsPathEntry(dirname(status.commandPath))
        return this.getStatus()
      }
      return status
    }
    if (status.state === 'conflict') {
      throw new Error(`Refusing to remove non-Orca command at ${status.commandPath}.`)
    }
    if (status.state === 'stale') {
      throw new Error(`Refusing to remove a command not owned by Orca at ${status.commandPath}.`)
    }

    if (status.installMethod === 'symlink') {
      await this.removeSymlink(status.commandPath)
    } else {
      await unlink(status.commandPath)
      await this.removeWindowsPathEntry(dirname(status.commandPath))
    }

    return this.getStatus()
  }

  private resolveInstallSpec(): InstallSpec | null {
    const commandPath = this.resolveCommandPath()
    if (!commandPath) {
      return null
    }

    if (this.platform === 'darwin' || this.platform === 'linux') {
      return {
        commandPath,
        // Why: AppImage runs from a FUSE mount at /tmp/.mount_*, so the
        // bundled launcher path is ephemeral. Use a wrapper script that
        // references the stable .AppImage file on disk instead of a symlink
        // that would break on next launch.
        installMethod: this.appImagePath ? 'wrapper' : 'symlink'
      }
    }

    if (this.platform === 'win32') {
      return {
        commandPath,
        installMethod: 'wrapper'
      }
    }

    return null
  }

  private resolveCommandPath(): string | null {
    if (this.commandPathOverride) {
      return this.commandPathOverride
    }

    if (this.platform === 'darwin') {
      return DEFAULT_MAC_COMMAND_PATH
    }

    if (this.platform === 'linux') {
      // Why: Linux does not have a single privileged global shell-command flow
      // equivalent to macOS's /usr/local/bin integration. ~/.local/bin is the
      // least surprising user-scoped location that many distros already expose.
      // Why: the command is `orca-ide` on Linux to avoid conflicting with
      // GNOME Orca (the screen reader), which ships as /usr/bin/orca on
      // Ubuntu, Fedora, and most GNOME-based distributions.
      return join(this.homePath, '.local', 'bin', 'orca-ide')
    }

    if (this.platform === 'win32') {
      return join(this.localAppDataPath, 'Programs', 'Orca', 'bin', 'orca.cmd')
    }

    return null
  }

  private async resolveLauncherPath(): Promise<string | null> {
    if (!['darwin', 'linux', 'win32'].includes(this.platform)) {
      return null
    }

    // Why: for AppImage, the launcher is the .AppImage file itself — the
    // wrapper script will invoke it with ELECTRON_RUN_AS_NODE. No need to
    // resolve the ephemeral bundled launcher inside the FUSE mount.
    if (this.appImagePath) {
      return existsSync(this.appImagePath) ? this.appImagePath : null
    }

    if (this.isPackaged) {
      const bundledPath = getBundledLauncherPath(this.platform, this.resourcesPath)
      return bundledPath && existsSync(bundledPath) ? bundledPath : null
    }

    return ensureDevLauncher({
      platform: this.platform,
      userDataPath: this.userDataPath,
      execPath: this.execPathValue,
      cliEntryPath: join(this.appPathValue, 'out', 'cli', 'index.js')
    })
  }

  private async installSymlink(status: CliInstallStatus): Promise<void> {
    try {
      if (status.state === 'installed') {
        return
      }
      if (status.state === 'stale') {
        await unlink(status.commandPath as string)
      }
      await symlink(status.launcherPath as string, status.commandPath as string)
    } catch (error) {
      if (this.platform !== 'darwin' || !isPermissionError(error)) {
        throw error
      }

      // Why: macOS shell-command registration should behave like VS Code and
      // place a stable symlink in /usr/local/bin instead of rewriting shell rc
      // files. Fallback to an elevated shell command keeps the public command
      // stable even when the app lacks direct write access to that directory.
      await this.privilegedRunner(
        `mkdir -p ${quoteShell(dirname(status.commandPath as string))} && ` +
          `ln -sfn ${quoteShell(status.launcherPath as string)} ${quoteShell(status.commandPath as string)}`
      )
    }
  }

  private async removeSymlink(commandPath: string): Promise<void> {
    try {
      await unlink(commandPath)
    } catch (error) {
      if (this.platform !== 'darwin' || !isPermissionError(error)) {
        throw error
      }
      await this.privilegedRunner(
        `if [ -L ${quoteShell(commandPath)} ]; then rm ${quoteShell(commandPath)}; fi`
      )
    }
  }

  private async installWindowsWrapper(commandPath: string, launcherPath: string): Promise<void> {
    await writeFile(commandPath, buildWindowsForwarder(launcherPath), 'utf8')
  }

  // Why: AppImage runs from a FUSE mount at /tmp/.mount_OrcaXXXXX/ that is
  // recreated on every launch with a different suffix. A symlink into that
  // mount breaks on next boot. Instead, write a self-contained bash wrapper
  // that locates the stable .AppImage file on disk and runs the CLI entry
  // point with ELECTRON_RUN_AS_NODE.
  private async installAppImageWrapper(commandPath: string, appImagePath: string): Promise<void> {
    const content = buildAppImageWrapper(appImagePath)
    await writeFile(commandPath, content, { encoding: 'utf8', mode: 0o755 })
  }

  private async inspectAppImageWrapper(
    commandPath: string,
    appImagePath: string
  ): Promise<CliInstallStatus> {
    try {
      const stats = await lstat(commandPath)
      if (!stats.isFile()) {
        return this.buildStatus({
          commandPath,
          launcherPath: appImagePath,
          installMethod: 'wrapper',
          supported: true,
          state: 'conflict',
          currentTarget: null,
          detail: `${commandPath} exists but is not an Orca launcher script.`
        })
      }

      const currentContent = await readFile(commandPath, 'utf8')
      const expectedContent = buildAppImageWrapper(appImagePath)
      return this.buildStatus({
        commandPath,
        launcherPath: appImagePath,
        installMethod: 'wrapper',
        supported: true,
        state: currentContent === expectedContent ? 'installed' : 'stale',
        currentTarget: appImagePath,
        detail:
          currentContent === expectedContent
            ? `Registered at ${commandPath}.`
            : `${commandPath} points to a different launcher.`
      })
    } catch (error) {
      if (isMissingError(error)) {
        return this.buildStatus({
          commandPath,
          launcherPath: appImagePath,
          installMethod: 'wrapper',
          supported: true,
          state: 'not_installed',
          currentTarget: null,
          detail: `Register ${commandPath} to use Orca from the terminal.`
        })
      }
      throw error
    }
  }

  private async inspectSymlink(
    commandPath: string,
    launcherPath: string
  ): Promise<CliInstallStatus> {
    try {
      const stats = await lstat(commandPath)
      if (!stats.isSymbolicLink()) {
        return this.buildStatus({
          commandPath,
          launcherPath,
          installMethod: 'symlink',
          supported: true,
          state: 'conflict',
          currentTarget: null,
          detail: `${commandPath} exists but is not an Orca symlink.`
        })
      }

      const currentTarget = await readlink(commandPath)
      const resolvedCurrentTarget = resolve(dirname(commandPath), currentTarget)
      const resolvedLauncher = resolve(launcherPath)
      return this.buildStatus({
        commandPath,
        launcherPath,
        installMethod: 'symlink',
        supported: true,
        state: resolvedCurrentTarget === resolvedLauncher ? 'installed' : 'stale',
        currentTarget: resolvedCurrentTarget,
        detail:
          resolvedCurrentTarget === resolvedLauncher
            ? `Registered at ${commandPath}.`
            : `${commandPath} points to a different launcher.`
      })
    } catch (error) {
      if (isMissingError(error)) {
        return this.buildStatus({
          commandPath,
          launcherPath,
          installMethod: 'symlink',
          supported: true,
          state: 'not_installed',
          currentTarget: null,
          detail: `Register ${commandPath} to use Orca from the terminal.`
        })
      }
      throw error
    }
  }

  private async inspectWindowsWrapper(
    commandPath: string,
    launcherPath: string
  ): Promise<CliInstallStatus> {
    try {
      const stats = await lstat(commandPath)
      if (!stats.isFile()) {
        return this.buildStatus({
          commandPath,
          launcherPath,
          installMethod: 'wrapper',
          supported: true,
          state: 'conflict',
          currentTarget: null,
          detail: `${commandPath} exists but is not an Orca launcher script.`
        })
      }

      const currentContent = await readFile(commandPath, 'utf8')
      const expectedContent = buildWindowsForwarder(launcherPath)
      return this.buildStatus({
        commandPath,
        launcherPath,
        installMethod: 'wrapper',
        supported: true,
        state: currentContent === expectedContent ? 'installed' : 'stale',
        currentTarget: launcherPath,
        detail:
          currentContent === expectedContent
            ? `Registered at ${commandPath}.`
            : `${commandPath} points to a different launcher.`
      })
    } catch (error) {
      if (isMissingError(error)) {
        return this.buildStatus({
          commandPath,
          launcherPath,
          installMethod: 'wrapper',
          supported: true,
          state: 'not_installed',
          currentTarget: null,
          detail: `Register ${commandPath} to use Orca from Command Prompt or PowerShell.`
        })
      }
      throw error
    }
  }

  private buildStatus(args: {
    commandPath: string
    launcherPath: string
    installMethod: CliInstallMethod
    supported: boolean
    state: CliInstallStatus['state']
    currentTarget: string | null
    detail: string | null
  }): CliInstallStatus {
    return {
      platform: this.platform,
      commandName: this.commandName,
      commandPath: args.commandPath,
      pathDirectory: dirname(args.commandPath),
      pathConfigured: false,
      launcherPath: args.launcherPath,
      installMethod: args.installMethod,
      supported: args.supported,
      state: args.state,
      currentTarget: args.currentTarget,
      unsupportedReason: null,
      detail: args.detail
    }
  }

  private async isPathConfigured(pathDirectory: string): Promise<boolean> {
    const pathValue =
      this.platform === 'win32' ? await this.userPathReader() : (this.processPathEnv ?? '')
    return splitPathEntries(this.platform, pathValue).some((entry) =>
      samePathEntry(this.platform, entry, pathDirectory)
    )
  }

  private withPathInfo(
    status: CliInstallStatus,
    pathDirectory: string,
    pathConfigured: boolean
  ): CliInstallStatus {
    if (status.state !== 'installed') {
      return {
        ...status,
        pathDirectory,
        pathConfigured
      }
    }

    if (pathConfigured) {
      return {
        ...status,
        pathDirectory,
        pathConfigured
      }
    }

    return {
      ...status,
      pathDirectory,
      pathConfigured,
      detail:
        this.platform === 'linux'
          ? `${status.commandPath} is registered, but ${pathDirectory} is not on PATH for this shell.`
          : `${status.commandPath} is registered. Restart your shell if the command is not visible yet.`
    }
  }

  private async ensureWindowsPathEntry(pathDirectory: string): Promise<void> {
    const current = await this.userPathReader()
    const entries = splitPathEntries('win32', current)
    if (entries.some((entry) => samePathEntry('win32', entry, pathDirectory))) {
      return
    }
    entries.push(pathDirectory)
    await this.userPathWriter(entries.join(';'))
  }

  private async removeWindowsPathEntry(pathDirectory: string): Promise<void> {
    if (this.platform !== 'win32') {
      return
    }
    const current = await this.userPathReader()
    const nextEntries = splitPathEntries('win32', current).filter(
      (entry) => !samePathEntry('win32', entry, pathDirectory)
    )
    await this.userPathWriter(nextEntries.join(';'))
  }
}

async function ensureDevLauncher(args: {
  platform: NodeJS.Platform
  userDataPath: string
  execPath: string
  cliEntryPath: string
}): Promise<string | null> {
  if (
    !isAbsoluteForPlatform(args.platform, args.execPath) ||
    !isAbsolute(args.cliEntryPath) ||
    !existsSync(args.cliEntryPath)
  ) {
    return null
  }

  const launcherPath = join(
    args.userDataPath,
    ...DEV_LAUNCHER_DIR,
    args.platform === 'win32' ? 'orca.cmd' : args.platform === 'linux' ? 'orca-ide' : 'orca'
  )
  await mkdir(dirname(launcherPath), { recursive: true })

  // Why: packaged Orca ships real platform launchers under resources/bin, but
  // development builds do not have that stable asset layout. Generating a
  // launcher in userData lets us validate the shell-command flow without
  // changing the packaged registration contract.
  const content =
    args.platform === 'win32'
      ? buildWindowsDevLauncher(args.execPath, args.cliEntryPath)
      : buildUnixDevLauncher(args.execPath, args.cliEntryPath)
  await writeFile(launcherPath, content, {
    encoding: 'utf8',
    mode: args.platform === 'win32' ? undefined : 0o755
  })
  return launcherPath
}

function buildUnixDevLauncher(execPathValue: string, cliEntryPath: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail
ELECTRON=${quoteShell(execPathValue)}
CLI=${quoteShell(cliEntryPath)}
export ORCA_NODE_OPTIONS="\${NODE_OPTIONS-}"
export ORCA_NODE_REPL_EXTERNAL_MODULE="\${NODE_REPL_EXTERNAL_MODULE-}"
unset NODE_OPTIONS
unset NODE_REPL_EXTERNAL_MODULE
ELECTRON_RUN_AS_NODE=1 "$ELECTRON" "$CLI" "$@"
`
}

function buildWindowsDevLauncher(execPathValue: string, cliEntryPath: string): string {
  return `@echo off
setlocal
set "ELECTRON=${escapeWindowsBatchValue(execPathValue)}"
set "CLI=${escapeWindowsBatchValue(cliEntryPath)}"
set "ORCA_NODE_OPTIONS=%NODE_OPTIONS%"
set "ORCA_NODE_REPL_EXTERNAL_MODULE=%NODE_REPL_EXTERNAL_MODULE%"
set NODE_OPTIONS=
set NODE_REPL_EXTERNAL_MODULE=
set ELECTRON_RUN_AS_NODE=1
"%ELECTRON%" "%CLI%" %*
`
}

// Why: AppImage bundles the entire app into a single executable that mounts
// a FUSE filesystem at /tmp/.mount_OrcaXXXXX on each launch. The mount path
// changes every time, so a symlink into it breaks on reboot. This wrapper
// script references the stable .AppImage file path on disk and uses
// ELECTRON_RUN_AS_NODE to run the CLI entry point directly, mirroring the
// same pattern as the bundled resources/linux/bin/orca-ide launcher but
// without depending on the ephemeral FUSE mount.
function buildAppImageWrapper(appImagePath: string): string {
  // Why: AppImage bundles the app into a single file that mounts a FUSE
  // filesystem at /tmp/.mount_OrcaXXXXX on each launch. The mount path
  // changes every time, so a symlink into it breaks on reboot.
  //
  // With ELECTRON_RUN_AS_NODE=1, the AppImage runtime still mounts the
  // squashfs and sets $APPDIR to the mount root, then runs the embedded
  // Electron binary as a plain Node process. We pass a `-e` inline script
  // that resolves the CLI entry point from $APPDIR at runtime — this avoids
  // hardcoding the ephemeral mount path while keeping the wrapper stable.
  return `#!/usr/bin/env bash
set -euo pipefail
# Orca IDE CLI wrapper (AppImage)
APPIMAGE=${quoteShell(appImagePath)}
if [ ! -f "$APPIMAGE" ]; then
  echo "Orca AppImage not found at $APPIMAGE" >&2
  echo "If you moved the AppImage, re-run CLI registration from Orca Settings." >&2
  exit 1
fi
export ORCA_NODE_OPTIONS="\${NODE_OPTIONS-}"
export ORCA_NODE_REPL_EXTERNAL_MODULE="\${NODE_REPL_EXTERNAL_MODULE-}"
unset NODE_OPTIONS
unset NODE_REPL_EXTERNAL_MODULE
# Why: $APPDIR is set by the AppImage runtime to the FUSE mount root.
# The -e script resolves the CLI entry point at runtime so the wrapper
# does not depend on the ephemeral mount path.
ELECTRON_RUN_AS_NODE=1 exec "$APPIMAGE" -e "require(require('path').join(process.env.APPDIR,'resources/app.asar.unpacked/out/cli/index.js')).main(process.argv.slice(1))" "$@"
`
}

function buildWindowsForwarder(launcherPath: string): string {
  return `@echo off
setlocal
set "ORCA_LAUNCHER=${escapeWindowsBatchValue(launcherPath)}"
"%ORCA_LAUNCHER%" %*
`
}

function splitPathEntries(platform: NodeJS.Platform, value: string | null): string[] {
  if (!value) {
    return []
  }
  return value
    .split(platform === 'win32' ? ';' : ':')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function samePathEntry(platform: NodeJS.Platform, left: string, right: string): boolean {
  return platform === 'win32'
    ? normalizeWindowsPath(left) === normalizeWindowsPath(right)
    : left === right
}

function normalizeWindowsPath(value: string): string {
  return value.replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase()
}

function escapeWindowsBatchValue(value: string): string {
  return value.replaceAll('"', '""')
}

function isPermissionError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    ((error as NodeJS.ErrnoException).code === 'EACCES' ||
      (error as NodeJS.ErrnoException).code === 'EPERM')
  )
}

function isMissingError(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

async function runMacPrivilegedCommand(command: string): Promise<void> {
  await execFileAsync('osascript', [
    '-e',
    `do shell script ${quoteAppleScript(command)} with administrator privileges`
  ])
}

function quoteAppleScript(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

function isAbsoluteForPlatform(platform: NodeJS.Platform, value: string): boolean {
  if (platform === 'win32') {
    return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
  }
  return isAbsolute(value)
}

async function readWindowsUserPath(): Promise<string | null> {
  const { stdout } = await execFileAsync('powershell', [
    '-NoProfile',
    '-Command',
    "[Environment]::GetEnvironmentVariable('Path','User')"
  ])
  return stdout.trim() || null
}

async function writeWindowsUserPath(value: string): Promise<void> {
  await execFileAsync('powershell', [
    '-NoProfile',
    '-Command',
    // Why: PATH registration must stay user-scoped on Windows so the Orca
    // desktop app can manage the public shell command without requiring
    // elevation or mutating machine-wide environment state.
    `[Environment]::SetEnvironmentVariable('Path', ${quotePowerShell(value)}, 'User')`
  ])
}

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

export function getBundledLauncherPath(
  platform: NodeJS.Platform,
  resourcesPath: string
): string | null {
  if (platform === 'darwin') {
    return join(resourcesPath, 'bin', 'orca')
  }
  // Why: Linux uses `orca-ide` to avoid conflicting with GNOME Orca.
  if (platform === 'linux') {
    return join(resourcesPath, 'bin', 'orca-ide')
  }
  if (platform === 'win32') {
    return join(resourcesPath, 'bin', 'orca.cmd')
  }
  return null
}
