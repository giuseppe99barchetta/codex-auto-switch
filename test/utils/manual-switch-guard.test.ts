/** Tests for manual profile-switch safety confirmation. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { confirmManualProfileSwitch } from '../../src/utils/manual-switch-guard'

function makeDeps(overrides: Record<string, unknown> = {}) {
  const calls: string[] = []
  const deps = {
    enabled: true,
    executeCommand: async <T = unknown>(command: string, ...args: unknown[]) => {
      calls.push(`command:${command}:${String(args[0] ?? '')}`)
      return false as T
    },
    showWarningMessage: async (
      message: string,
      _options: { modal: boolean },
      ...items: string[]
    ) => {
      calls.push(`warning:${message}`)
      return items[0]
    },
    translate: (message: string) => message,
    calls,
  }
  return Object.assign(deps, overrides)
}

test('manual switch guard allows switching when disabled', async () => {
  const deps = makeDeps({ enabled: false })
  assert.equal(await confirmManualProfileSwitch(deps), true)
  assert.deepEqual(deps.calls, [])
})

test('manual switch guard allows switching when no chat request is active', async () => {
  const deps = makeDeps()
  assert.equal(await confirmManualProfileSwitch(deps), true)
  assert.deepEqual(deps.calls, [
    'command:getContextKeyValue:chatSessionRequestInProgress',
  ])
})

test('manual switch guard tolerates unavailable chat activity probe', async () => {
  const deps = makeDeps({
    executeCommand: async () => {
      throw new Error('unsupported command')
    },
  })
  assert.equal(await confirmManualProfileSwitch(deps), true)
})

test('manual switch guard blocks an active-chat switch when confirmation is dismissed', async () => {
  const deps = makeDeps({
    executeCommand: async <T = unknown>() => true as T,
    showWarningMessage: async () => undefined,
  })
  assert.equal(await confirmManualProfileSwitch(deps), false)
})

test('manual switch guard allows an active-chat switch after explicit confirmation', async () => {
  const deps = makeDeps({
    executeCommand: async <T = unknown>() => true as T,
    showWarningMessage: async (
      _message: string,
      _options: { modal: boolean },
      ...items: string[]
    ) => items[0],
  })
  assert.equal(await confirmManualProfileSwitch(deps), true)
})
