export interface ManualSwitchGuardDeps {
  enabled: boolean
  executeCommand: (command: string, ...rest: any[]) => PromiseLike<unknown>
  showWarningMessage: (
    message: string,
    options: { modal: boolean },
    ...items: string[]
  ) => PromiseLike<string | undefined>
  translate: (message: string, ...args: any[]) => string
}

const CHAT_REQUEST_IN_PROGRESS_CONTEXT_KEY = 'chatSessionRequestInProgress'

/**
 * Confirms a manual profile switch when VS Code reports an active chat request.
 * If the internal context probe is unavailable, switching remains allowed rather
 * than blocking profile management on unsupported VS Code builds.
 */
export async function confirmManualProfileSwitch(
  deps: ManualSwitchGuardDeps,
): Promise<boolean> {
  if (!deps.enabled) {
    return true
  }

  let requestInProgress = false
  try {
    requestInProgress = Boolean(
      await deps.executeCommand(
        'getContextKeyValue',
        CHAT_REQUEST_IN_PROGRESS_CONTEXT_KEY,
      ),
    )
  } catch {
    return true
  }

  if (!requestInProgress) {
    return true
  }

  const continueLabel = deps.translate('Switch anyway')
  const selection = await deps.showWarningMessage(
    deps.translate(
      'Codex is currently generating a response. Switching accounts will restart the extension host and interrupt the active chat. Do you want to continue?',
    ),
    { modal: true },
    continueLabel,
  )

  return selection === continueLabel
}
