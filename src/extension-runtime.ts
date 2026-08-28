import * as vscode from 'vscode'
import type { ExtensionServices } from './extension-services'
import { createExtensionUiController } from './extension-ui-controller'
import { createStatusBarItem } from './ui/status-bar'
import { registerCommands } from './commands'
import {
  chooseStartupResetTarget,
  minimumAutoSwitchThreshold,
  normalizeAutoSwitchThreshold,
  normalizeAutoSwitchThresholds,
} from './utils/auto-switch-policy'
import {
  isHysteresisBlocked,
  type AutoSwitchHysteresisState,
  type PendingAutoSwitchState,
} from './utils/auto-switch-state'
import { autoSwitchLog, errorLog } from './utils/log'
import { restartExtensionHostOrReloadWindow } from './utils/vscode-restart'

const PENDING_AUTO_SWITCH_KEY = 'codexSwitch.pendingAutoSwitch.v1'
const AUTO_SWITCH_HYSTERESIS_KEY = 'codexSwitch.autoSwitchHysteresis.v1'

async function selectNearestResetProfileOnStartup(
  context: vscode.ExtensionContext,
  services: ExtensionServices,
): Promise<boolean> {
  const config = vscode.workspace.getConfiguration('codexSwitch')
  if (!config.get<boolean>('autoSelectNearestResetOnStartup', true)) {
    return false
  }

  const pending = context.globalState.get<PendingAutoSwitchState>(
    PENDING_AUTO_SWITCH_KEY,
  )
  if (pending) {
    autoSwitchLog('startup reset selection skipped: pending switch exists')
    return false
  }

  const { profileManager, profileMaintenanceService, profileRateLimitService } =
    services
  const profiles = await profileManager.listProfiles()
  const activeId = await profileManager.getActiveProfileId()
  if (!activeId || profiles.length < 2) {
    return false
  }

  await profileMaintenanceService.requestCycle({
    forceProfileIds: profiles.map((profile) => profile.id),
  })

  const profilesWithLimits = await Promise.all(
    profiles.map(async (profile) => {
      const cached = profileRateLimitService.applyCachedRateLimits([profile])[0]
      if (cached.rateLimits !== undefined) {
        return cached
      }
      const state = await profileMaintenanceService
        .readProfileState(profile.id)
        .catch(() => null)
      return state?.rateLimits
        ? { ...cached, rateLimits: state.rateLimits }
        : cached
    }),
  )

  const fallbackPercent = normalizeAutoSwitchThreshold(
    config.get<number>('autoSwitchThresholdPercent', 99),
  )
  const thresholds = normalizeAutoSwitchThresholds({
    fallbackPercent,
    fiveHourPercent: config.get<number>('autoSwitch5hThresholdPercent', 95),
    weeklyPercent: config.get<number>('autoSwitchWeeklyThresholdPercent', 98),
  })
  const recoveryPercent = Math.min(
    minimumAutoSwitchThreshold(thresholds) - 1,
    Math.max(0, config.get<number>('autoSwitchRecoveryPercent', 90)),
  )
  const hysteresisState = context.globalState.get<AutoSwitchHysteresisState>(
    AUTO_SWITCH_HYSTERESIS_KEY,
  )
  const now = Date.now()
  const eligibleProfiles = profilesWithLimits.filter(
    (profile) =>
      !isHysteresisBlocked(profile, hysteresisState, recoveryPercent, now),
  )
  const target = chooseStartupResetTarget(eligibleProfiles, thresholds, now)
  if (!target || target.id === activeId) {
    return false
  }

  const active = profilesWithLimits.find((profile) => profile.id === activeId)
  const switched = await profileManager.setActiveProfileId(target.id)
  if (!switched) {
    vscode.window.showWarningMessage(
      `Codex Switch could not verify the startup auth file for ${target.name}; keeping the current account.`,
    )
    return false
  }

  autoSwitchLog(
    `${active?.name ?? activeId} -> ${target.name} on startup (nearest quota reset)`,
  )
  vscode.window.showInformationMessage(
    `Codex Switch selected ${target.name} at startup because it has the nearest quota reset.`,
  )
  await restartExtensionHostOrReloadWindow()
  return true
}

/**
 * Starts the extension runtime, initializing the UI, command handlers, and watchers.
 * Called after all services are created to wire up the extension's interactive components.
 * @param context - The extension context from VS Code.
 * @param services - The initialized extension services.
 */
export function startExtensionRuntime(
  context: vscode.ExtensionContext,
  services: ExtensionServices,
): void {
  const { profileManager, codexHomeManager, profileRateLimitService, runtime } =
    services

  const statusBarItem = createStatusBarItem()
  context.subscriptions.push(statusBarItem)

  if (codexHomeManager.isWslCustomHomeUnsupported()) {
    vscode.window.showErrorMessage(
      'Codex Switch does not support a custom CODEX_HOME when Chat runs Codex in WSL. Disable codexHome.enabled or turn off runCodexInWindowsSubsystemForLinux.',
    )
    return
  }

  const uiController = createExtensionUiController(context, services)

  registerCommands(
    context,
    profileManager,
    codexHomeManager,
    runtime.home,
    profileRateLimitService,
    uiController.refreshUi,
  )

  context.subscriptions.push(
    ...profileManager.createWatchers(() => {
      void uiController.refreshUi()
    }, runtime.home.authPath),
  )

  void (async () => {
    await uiController.reconcileAndRefresh()
    await selectNearestResetProfileOnStartup(context, services)
  })().catch((error) => {
    errorLog('Error selecting nearest-reset Codex profile at startup:', error)
  })
}
