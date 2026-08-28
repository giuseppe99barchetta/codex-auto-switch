import * as vscode from 'vscode'
import type { ExtensionServices } from './extension-services'
import type { ProfileSummary, ResolvedCodexHome } from './types'
import { autoSwitchLog, errorLog } from './utils/log'
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
  minimumAutoSwitchThreshold,
  normalizeAutoSwitchThreshold,
  normalizeAutoSwitchThresholds,
  type AutoSwitchThresholds,
} from './utils/auto-switch-policy'
import {
  describeThresholdReason,
  findNextResetAt,
  getTriggeredResetAt,
  isHysteresisBlocked,
  type AutoSwitchHysteresisState,
  type PendingAutoSwitchState,
} from './utils/auto-switch-state'

const PENDING_AUTO_SWITCH_KEY = 'codexSwitch.pendingAutoSwitch.v1'
const AUTO_SWITCH_HYSTERESIS_KEY = 'codexSwitch.autoSwitchHysteresis.v1'

/** Controller for managing the extension's UI state and updates. */
export interface ExtensionUiController {
  refreshUi(options?: RefreshProfileUiOptions): Promise<void>
  reconcileAndRefresh(): Promise<void>
}

/** Creates a UI controller for profile state, switching, and usage display. */
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
  let pendingAutoSwitch = context.globalState.get<PendingAutoSwitchState>(
    PENDING_AUTO_SWITCH_KEY,
  )
  let hysteresisState = context.globalState.get<AutoSwitchHysteresisState>(
    AUTO_SWITCH_HYSTERESIS_KEY,
  )
  let pendingAutoSwitchNoticeShown = false
  let allAccountsExhaustedNoticeKey: string | null = null

  const getAutoSwitchThresholds = (
    config: vscode.WorkspaceConfiguration,
  ): AutoSwitchThresholds => {
    const fallbackPercent = normalizeAutoSwitchThreshold(
      config.get<number>('autoSwitchThresholdPercent', 99),
    )
    return normalizeAutoSwitchThresholds({
      fallbackPercent,
      fiveHourPercent: config.get<number>('autoSwitch5hThresholdPercent', 95),
      weeklyPercent: config.get<number>('autoSwitchWeeklyThresholdPercent', 98),
    })
  }

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

  const applyRateLimitState = async (
    profiles: ProfileSummary[],
  ): Promise<ProfileSummary[]> => {
    const states = await loadMaintenanceStates(profiles)
    return profiles.map((profile) => {
      const cached = profileRateLimitService.applyCachedRateLimits([profile])[0]
      const stateLimits = states.get(profile.id)?.rateLimits
      return cached.rateLimits === undefined && stateLimits
        ? { ...cached, rateLimits: stateLimits }
        : cached
    })
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
    const cachedProfiles = profiles.map((profile) => {
      const withCache = profileRateLimitService.applyCachedRateLimits([
        profile,
      ])[0]
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

  const persistPendingAutoSwitch = async (
    value: PendingAutoSwitchState | undefined,
  ): Promise<void> => {
    pendingAutoSwitch = value
    await context.globalState.update(PENDING_AUTO_SWITCH_KEY, value)
  }

  const persistHysteresis = async (
    value: AutoSwitchHysteresisState | undefined,
  ): Promise<void> => {
    hysteresisState = value
    await context.globalState.update(AUTO_SWITCH_HYSTERESIS_KEY, value)
  }

  const clearPendingAutoSwitch = async (reason?: string): Promise<void> => {
    if (pendingAutoSwitch && reason) {
      autoSwitchLog(`pending cancelled: ${reason}`)
    }
    pendingAutoSwitchNoticeShown = false
    await persistPendingAutoSwitch(undefined)
  }

  const formatResetTime = (resetAt: number): string =>
    new Date(resetAt).toLocaleString()

  const showAllAccountsExhausted = async (
    profiles: ProfileSummary[],
  ): Promise<void> => {
    const nextResetAt = findNextResetAt(profiles, Date.now())
    const key = `${profiles.map((profile) => profile.id).join(',')}:${nextResetAt ?? 'unknown'}`
    if (allAccountsExhaustedNoticeKey === key) {
      return
    }
    allAccountsExhaustedNoticeKey = key
    const resetText = nextResetAt
      ? ` Next known reset: ${formatResetTime(nextResetAt)}.`
      : ''
    autoSwitchLog(`all accounts exhausted.${resetText}`)
    await vscode.window.showWarningMessage(
      `All Codex accounts are currently exhausted.${resetText}`,
    )
  }

  const selectTarget = async (
    thresholds: AutoSwitchThresholds,
    recoveryPercent: number,
  ): Promise<{
    profiles: ProfileSummary[]
    active: ProfileSummary
    target: ProfileSummary | undefined
    reason: string
  } | null> => {
    const profiles = await profileManager.listProfiles()
    const activeId = await profileManager.getActiveProfileId()
    if (!activeId || profiles.length < 2) {
      return null
    }

    const profilesWithLimits = await applyRateLimitState(profiles)
    const active = profilesWithLimits.find((profile) => profile.id === activeId)
    if (!active) {
      return null
    }

    if (
      hysteresisState &&
      !isHysteresisBlocked(
        profilesWithLimits.find(
          (profile) => profile.id === hysteresisState?.profileId,
        ) ?? active,
        hysteresisState,
        recoveryPercent,
        Date.now(),
      )
    ) {
      autoSwitchLog(`hysteresis released for ${hysteresisState.profileId}`)
      await persistHysteresis(undefined)
    }

    const eligibleProfiles = profilesWithLimits.filter(
      (profile) =>
        profile.id === activeId ||
        !isHysteresisBlocked(
          profile,
          hysteresisState,
          recoveryPercent,
          Date.now(),
        ),
    )
    const target = chooseAutoSwitchTarget(
      eligibleProfiles,
      activeId,
      thresholds,
      Date.now(),
    )
    return {
      profiles: profilesWithLimits,
      active,
      target,
      reason: describeThresholdReason(active, thresholds),
    }
  }

  const applyAutoSwitch = async (
    state: PendingAutoSwitchState,
    thresholds: AutoSwitchThresholds,
    recoveryPercent: number,
  ): Promise<boolean> => {
    const selection = await selectTarget(thresholds, recoveryPercent)
    if (!selection || selection.active.id !== state.sourceId) {
      await clearPendingAutoSwitch('active profile changed')
      return false
    }
    if (!selection.target) {
      await clearPendingAutoSwitch('no eligible target remains')
      await showAllAccountsExhausted(selection.profiles)
      return false
    }

    const target = selection.target
    if (target.id !== state.targetId) {
      autoSwitchLog(
        `${selection.active.name}: pending target re-evaluated ${state.targetId} -> ${target.name}`,
      )
    }
    const switched = await profileManager.setActiveProfileId(target.id)
    if (!switched) {
      vscode.window.showWarningMessage(
        `Codex Switch could not verify the auth file for ${target.name}; the extension host was not restarted.`,
      )
      return false
    }

    const blockedUntilResetAt = getTriggeredResetAt(
      selection.active,
      thresholds,
    )
    await persistHysteresis({
      profileId: selection.active.id,
      blockedUntilResetAt,
    })
    await clearPendingAutoSwitch()
    lastAutoSwitchAt = Date.now()
    allAccountsExhaustedNoticeKey = null
    await refreshUi()

    const reason = selection.reason || state.reason || 'usage threshold reached'
    autoSwitchLog(
      `${selection.active.name} ${reason} -> switched to ${target.name}`,
    )
    vscode.window.showInformationMessage(
      `Codex account ${selection.active.name} reached ${reason}. Switched automatically to ${target.name}.`,
    )
    await restartExtensionHostOrReloadWindow()
    return true
  }

  const applyPendingAutoSwitch = async (): Promise<void> => {
    if (!pendingAutoSwitch) {
      vscode.window.showInformationMessage(
        'Codex Switch has no pending automatic account switch.',
      )
      return
    }
    const config = vscode.workspace.getConfiguration('codexSwitch')
    const thresholds = getAutoSwitchThresholds(config)
    const recoveryPercent = Math.min(
      minimumAutoSwitchThreshold(thresholds) - 1,
      Math.max(0, config.get<number>('autoSwitchRecoveryPercent', 90)),
    )
    await applyAutoSwitch(pendingAutoSwitch, thresholds, recoveryPercent)
  }

  const queueAutoSwitch = async (
    source: ProfileSummary,
    target: ProfileSummary,
    reason: string,
  ): Promise<void> => {
    const nextState: PendingAutoSwitchState = {
      sourceId: source.id,
      targetId: target.id,
      reason,
      createdAt: Date.now(),
    }
    const changed =
      !pendingAutoSwitch ||
      pendingAutoSwitch.sourceId !== nextState.sourceId ||
      pendingAutoSwitch.targetId !== nextState.targetId ||
      pendingAutoSwitch.reason !== nextState.reason

    if (changed) {
      await persistPendingAutoSwitch(nextState)
      pendingAutoSwitchNoticeShown = false
      autoSwitchLog(`${source.name} ${reason} -> pending ${target.name}`)
    }
    if (pendingAutoSwitchNoticeShown) {
      return
    }
    pendingAutoSwitchNoticeShown = true

    const action = await vscode.window.showWarningMessage(
      `${source.name} reached ${reason}. A switch to ${target.name} is pending so an active Codex response is not interrupted. Apply it after the current turn finishes.`,
      'Switch Now',
    )
    if (action === 'Switch Now') {
      await applyPendingAutoSwitch()
    }
  }

  const maybeAutoSwitchProfile = async (): Promise<void> => {
    const config = vscode.workspace.getConfiguration('codexSwitch')
    if (!config.get<boolean>('autoSwitchOnRateLimit', true)) {
      await clearPendingAutoSwitch('automatic switching disabled')
      return
    }

    const thresholds = getAutoSwitchThresholds(config)
    const recoveryPercent = Math.min(
      minimumAutoSwitchThreshold(thresholds) - 1,
      Math.max(0, config.get<number>('autoSwitchRecoveryPercent', 90)),
    )
    const cooldownSeconds = Math.max(
      5,
      config.get<number>('autoSwitchCooldownSeconds', 30),
    )
    if (Date.now() - lastAutoSwitchAt < cooldownSeconds * 1000) {
      return
    }

    const selection = await selectTarget(thresholds, recoveryPercent)
    if (!selection) {
      await clearPendingAutoSwitch('no active profile or insufficient profiles')
      return
    }

    if (!selection.reason) {
      await clearPendingAutoSwitch('active account recovered below threshold')
      allAccountsExhaustedNoticeKey = null
      return
    }

    if (!selection.target) {
      await clearPendingAutoSwitch('no eligible target')
      await showAllAccountsExhausted(selection.profiles)
      return
    }

    allAccountsExhaustedNoticeKey = null
    if (config.get<boolean>('autoSwitchDeferUntilSafe', true)) {
      await queueAutoSwitch(
        selection.active,
        selection.target,
        selection.reason,
      )
      return
    }

    await applyAutoSwitch(
      {
        sourceId: selection.active.id,
        targetId: selection.target.id,
        reason: selection.reason,
        createdAt: Date.now(),
      },
      thresholds,
      recoveryPercent,
    )
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
      void profileMaintenanceService.requestCycle()
      void refreshUi()
      requestAutoSwitch()
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
        event.affectsConfiguration(
          'codexSwitch.autoSwitch5hThresholdPercent',
        ) ||
        event.affectsConfiguration(
          'codexSwitch.autoSwitchWeeklyThresholdPercent',
        ) ||
        event.affectsConfiguration('codexSwitch.autoSwitchRecoveryPercent') ||
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

  if (pendingAutoSwitch) {
    autoSwitchLog(
      `restored pending switch ${pendingAutoSwitch.sourceId} -> ${pendingAutoSwitch.targetId}`,
    )
  }

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
