import * as vscode from 'vscode'
import type { ExtensionServices } from './extension-services'
import type { ProfileSummary, ResolvedCodexHome } from './types'
import { errorLog } from './utils/log'
import {
  mergeRefreshOptions,
  type RefreshProfileUiOptions,
} from './utils/refresh-options'
import { getRateLimitAutoRefreshIntervalSeconds } from './utils/refresh-config'
import { restartExtensionHostOrReloadWindow } from './utils/vscode-restart'
import { updateProfileStatus } from './ui/status-bar'
import {
  formatProfileRefreshCells,
  type ProfileRefreshStatus,
} from './utils/profile-refresh-status'
import type { MaintenanceProfileState } from './utils/profile-maintenance-state'
import {
  chooseAutoSwitchTarget,
  normalizeAutoSwitchThreshold,
} from './utils/auto-switch-policy'

/**
 * Controller for managing the extension's UI state and updates.
 */
export interface ExtensionUiController {
  /**
   * Refreshes the UI to reflect current profile and state.
   * @param options - Optional options controlling what to refresh.
   * @returns A promise that resolves when the UI refresh completes.
   */
  refreshUi(options?: RefreshProfileUiOptions): Promise<void>
  /**
   * Reconciles the stored profile state with Codex auth and refreshes the UI.
   * Called on extension startup to handle external auth changes.
   * @returns A promise that resolves when reconciliation and refresh complete.
   */
  reconcileAndRefresh(): Promise<void>
}

/**
 * Creates a UI controller for managing the extension's UI state.
 * Handles status bar updates, profile switching, and rate limit display.
 * @param context - The extension context from VS Code.
 * @param services - The initialized extension services.
 * @returns A controller for managing extension UI updates.
 */
export function createExtensionUiController(
  context: vscode.ExtensionContext,
  services: ExtensionServices,
): ExtensionUiController {
  const {
    profileManager,
    codexHomeManager,
    profileRateLimitService,
    profileMaintenanceService,
    runtime,
  } = services

  let refreshProfileUiGeneration = 0
  let refreshProfileUiPromise: Promise<void> | null = null
  let pendingRefreshProfileUiOptions: RefreshProfileUiOptions | null = null
  let autoSwitchPromise: Promise<void> | null = null
  let lastAutoSwitchAt = 0
  let pendingAutoSwitchTargetId: string | null = null
  let pendingAutoSwitchSourceId: string | null = null
  let pendingAutoSwitchNoticeShown = false

  const mapStateToRefreshStatus = (
    profileId: string,
    state: MaintenanceProfileState | null,
  ): ProfileRefreshStatus => ({
    lastSuccessAt: state?.lastSuccessAt ?? undefined,
    nextDueAt: state?.nextDueAt ?? undefined,
    nextRetryAt: state?.nextRetryAt ?? undefined,
    isRefreshing: profileMaintenanceService.getActiveProfileId() === profileId,
  })

  const loadMaintenanceStates = async (
    profiles: ProfileSummary[],
  ): Promise<Map<string, MaintenanceProfileState | null>> => {
    const entries = await Promise.all(
      profiles.map(
        async (profile): Promise<[string, MaintenanceProfileState | null]> => {
          const state = await profileMaintenanceService
            .readProfileState(profile.id)
            .catch(() => null)
          return [profile.id, state]
        },
      ),
    )
    return new Map(entries)
  }

  const buildRefreshLabel = (
    statuses: Map<string, ProfileRefreshStatus>,
  ): ((profileId: string) => string) => {
    const intervalSeconds = getRateLimitAutoRefreshIntervalSeconds()
    const now = Date.now()
    const autoRefreshEnabled = intervalSeconds > 0
    return (profileId: string): string => {
      const status = statuses.get(profileId)
      if (!status) {
        return ''
      }
      if (status.isRefreshing) {
        return '…'
      }
      const cells = formatProfileRefreshCells(status, {
        now,
        autoRefreshEnabled,
      })
      if (!cells.updated) {
        return ''
      }
      return cells.next ? `${cells.updated}/${cells.next}` : cells.updated
    }
  }

  const refreshProfileUi = async (
    home: ResolvedCodexHome,
    options: RefreshProfileUiOptions = {},
  ): Promise<void> => {
    const generation = ++refreshProfileUiGeneration

    const profiles = await profileManager.listProfiles()
    let activeId = await profileManager.getActiveProfileId()
    if (activeId && !profiles.some((profile) => profile.id === activeId)) {
      await profileManager.setActiveProfileId(undefined)
      activeId = undefined
    }

    const activeHome = codexHomeManager.isEnabled() ? home : undefined

    const maintenanceStates = await loadMaintenanceStates(profiles)

    // Apply in-memory cached rate limits; fall back to the state-file rate limits
    // when the in-memory cache is empty (e.g. after an extension restart or
    // when another window ran the last maintenance cycle).
    const cachedProfiles = profiles.map((profile) => {
      const withCache = profileRateLimitService
        ? profileRateLimitService.applyCachedRateLimits([profile])[0]
        : profile
      if (withCache.rateLimits === undefined) {
        const state = maintenanceStates.get(profile.id)
        if (state?.rateLimits) {
          return { ...withCache, rateLimits: state.rateLimits }
        }
      }
      return withCache
    })

    const statuses = new Map(
      profiles.map((profile) => {
        const state = maintenanceStates.get(profile.id)
        return [profile.id, mapStateToRefreshStatus(profile.id, state ?? null)]
      }),
    )

    const cachedActiveProfile = activeId
      ? cachedProfiles.find((profile) => profile.id === activeId) || null
      : null

    if (generation !== refreshProfileUiGeneration) {
      return
    }

    updateProfileStatus(
      cachedActiveProfile,
      cachedProfiles,
      activeHome,
      buildRefreshLabel(statuses),
    )

    // Background freshness, all-profile coverage, and auth write-back are owned
    // by the maintenance scheduler. A manual refresh forces every profile.
    if (options.forceRateLimitRefresh) {
      void profileMaintenanceService.requestCycle({
        forceProfileIds: profiles.map((profile) => profile.id),
      })
    }
  }

  const refreshUi = async (options: RefreshProfileUiOptions = {}) => {
    if (refreshProfileUiPromise) {
      pendingRefreshProfileUiOptions = mergeRefreshOptions(
        pendingRefreshProfileUiOptions,
        options,
      )
      return await refreshProfileUiPromise
    }

    refreshProfileUiPromise = (async () => {
      let nextOptions: RefreshProfileUiOptions | null = options
      do {
        const currentOptions = nextOptions
        pendingRefreshProfileUiOptions = null

        try {
          await refreshProfileUi(runtime.home, currentOptions)
        } catch (error) {
          errorLog('Error refreshing profile UI:', error)
          updateProfileStatus(null, [])
        }

        nextOptions = pendingRefreshProfileUiOptions
      } while (nextOptions)
    })()

    try {
      await refreshProfileUiPromise
    } finally {
      refreshProfileUiPromise = null
    }
  }

  const clearPendingAutoSwitch = (): void => {
    pendingAutoSwitchTargetId = null
    pendingAutoSwitchSourceId = null
    pendingAutoSwitchNoticeShown = false
  }

  const applyAutoSwitch = async (
    sourceId: string,
    targetId: string,
  ): Promise<boolean> => {
    const profiles = await profileManager.listProfiles()
    const activeId = await profileManager.getActiveProfileId()
    if (activeId !== sourceId) {
      clearPendingAutoSwitch()
      return false
    }

    const previous = profiles.find((profile) => profile.id === sourceId)
    const target = profiles.find((profile) => profile.id === targetId)
    if (!target) {
      clearPendingAutoSwitch()
      return false
    }

    const switched = await profileManager.setActiveProfileId(target.id)
    if (!switched) {
      return false
    }

    clearPendingAutoSwitch()
    lastAutoSwitchAt = Date.now()
    await refreshUi()
    vscode.window.showInformationMessage(
      previous
        ? `Codex account ${previous.name} reached its usage threshold. Switched automatically to ${target.name}.`
        : `Codex usage threshold reached. Switched automatically to ${target.name}.`,
    )

    // Codex can keep authentication in its extension-host process. Restarting
    // that host makes the newly written auth.json effective for the next turn;
    // the helper falls back to a full window reload only when necessary.
    await restartExtensionHostOrReloadWindow()
    return true
  }

  const applyPendingAutoSwitch = async (): Promise<void> => {
    if (!pendingAutoSwitchSourceId || !pendingAutoSwitchTargetId) {
      vscode.window.showInformationMessage(
        'Codex Switch has no pending automatic account switch.',
      )
      return
    }

    await applyAutoSwitch(
      pendingAutoSwitchSourceId,
      pendingAutoSwitchTargetId,
    )
  }

  const queueAutoSwitch = async (
    source: ProfileSummary | undefined,
    target: ProfileSummary,
  ): Promise<void> => {
    pendingAutoSwitchSourceId = source?.id ?? null
    pendingAutoSwitchTargetId = target.id

    if (pendingAutoSwitchNoticeShown) {
      return
    }
    pendingAutoSwitchNoticeShown = true

    const sourceName = source?.name ?? 'Current Codex account'
    const action = await vscode.window.showWarningMessage(
      `${sourceName} reached the automatic switch threshold. A switch to ${target.name} is pending so an active Codex response is not interrupted. Apply it after the current turn finishes.`,
      'Switch Now',
    )
    if (action === 'Switch Now') {
      await applyPendingAutoSwitch()
    }
  }

  const maybeAutoSwitchProfile = async (): Promise<void> => {
    const config = vscode.workspace.getConfiguration('codexSwitch')
    if (!config.get<boolean>('autoSwitchOnRateLimit', true)) {
      clearPendingAutoSwitch()
      return
    }

    const threshold = normalizeAutoSwitchThreshold(
      config.get<number>('autoSwitchThresholdPercent', 99),
    )
    const cooldownSeconds = Math.max(
      5,
      config.get<number>('autoSwitchCooldownSeconds', 30),
    )
    const now = Date.now()
    if (now - lastAutoSwitchAt < cooldownSeconds * 1000) {
      return
    }

    const profiles = await profileManager.listProfiles()
    const activeId = await profileManager.getActiveProfileId()
    if (!activeId || profiles.length < 2) {
      clearPendingAutoSwitch()
      return
    }

    const states = await loadMaintenanceStates(profiles)
    const profilesWithLimits = profiles.map((profile) => {
      const cached = profileRateLimitService.applyCachedRateLimits([profile])[0]
      const stateLimits = states.get(profile.id)?.rateLimits
      return cached.rateLimits === undefined && stateLimits
        ? { ...cached, rateLimits: stateLimits }
        : cached
    })

    const target = chooseAutoSwitchTarget(
      profilesWithLimits,
      activeId,
      threshold,
    )
    if (!target) {
      clearPendingAutoSwitch()
      return
    }

    const previous = profilesWithLimits.find(
      (profile) => profile.id === activeId,
    )
    const deferUntilSafe = config.get<boolean>('autoSwitchDeferUntilSafe', true)
    if (deferUntilSafe) {
      await queueAutoSwitch(previous, target)
      return
    }

    await applyAutoSwitch(activeId, target.id)
  }

  const requestAutoSwitch = (): void => {
    if (autoSwitchPromise) {
      return
    }
    autoSwitchPromise = maybeAutoSwitchProfile()
      .catch((error) => {
        errorLog('Error automatically switching Codex profile:', error)
      })
      .finally(() => {
        autoSwitchPromise = null
      })
  }

  const applyPendingAutoSwitchCommand = vscode.commands.registerCommand(
    'codex-switch.autoSwitch.applyPending',
    applyPendingAutoSwitch,
  )

  // Re-render whenever the maintenance scheduler publishes a new result and
  // evaluate whether the active account should fail over to another profile.
  profileMaintenanceService.setStateChangedListener(() => {
    void refreshUi()
    requestAutoSwitch()
  })
  profileMaintenanceService.start()

  context.subscriptions.push(
    applyPendingAutoSwitchCommand,
    vscode.window.onDidChangeWindowState((state) => {
      if (!state.focused) {
        return
      }
      // Refresh local UI from shared state and request a cycle without
      // bypassing freshness; the lease prevents duplicate background work.
      void profileMaintenanceService.requestCycle()
      void refreshUi()
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration('codexSwitch.storageMode') ||
        event.affectsConfiguration('codexSwitch.codexHome.enabled') ||
        event.affectsConfiguration('chatgpt.runCodexInWindowsSubsystemForLinux')
      ) {
        void (async () => {
          await profileMaintenanceService.dispose()
          await profileRateLimitService?.dispose()
          vscode.window.showInformationMessage(
            'Codex Switch auth/storage settings changed. Restarting the extension host to apply the new home and storage targets.',
          )
          await restartExtensionHostOrReloadWindow()
        })()
        return
      }

      if (
        event.affectsConfiguration(
          'codexSwitch.rateLimitAutoRefreshIntervalSeconds',
        )
      ) {
        profileMaintenanceService.reschedule()
        void refreshUi()
      }

      if (
        event.affectsConfiguration('codexSwitch.autoSwitchOnRateLimit') ||
        event.affectsConfiguration('codexSwitch.autoSwitchThresholdPercent') ||
        event.affectsConfiguration('codexSwitch.autoSwitchDeferUntilSafe') ||
        event.affectsConfiguration('codexSwitch.autoSwitchCooldownSeconds')
      ) {
        requestAutoSwitch()
      }
    }),
    new vscode.Disposable(() => {
      void profileMaintenanceService.dispose()
    }),
  )

  return {
    refreshUi,
    reconcileAndRefresh: async () => {
      try {
        await profileManager.reconcileActiveProfileWithCodexAuthFile()
        await refreshUi({ refreshActiveRateLimitOnly: true })
        requestAutoSwitch()
      } catch (error) {
        errorLog('Error reconciling active profile with auth file:', error)
      }
    },
  }
}
