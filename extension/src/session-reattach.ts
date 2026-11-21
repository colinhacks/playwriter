// CDP session state needed to reattach a tab after Chrome detached it unexpectedly.
//
// Chrome force-detaches chrome.debugger from the whole tab when any frame starts navigating
// to another extension's chrome-extension:// URL, for example the inline menu 1Password
// injects when a form field gets focus. The check runs at navigation start in the browser
// process, so removing the iframe after insertion is always too late. background.ts reattaches
// with the same sessionId and uses this module to restore what Playwright saw before.
// Chromium marked this Won't Fix (Intended Behavior): https://issues.chromium.org/issues/498987209
// See https://github.com/remorses/playwriter/issues/127
import type { Protocol } from 'playwriter/src/cdp-types'

type SetupCommand = {
  method: string
  params?: object
  // Current Chrome identifier of an init script. Playwright gets a stable id instead,
  // because Chrome reuses identifiers in a new session.
  scriptIdentifier?: string
}

type TabSession = {
  // Setup Playwright sent on the tab's root session, in replay order. Keys make later commands
  // replace or remove earlier ones, e.g. Network.disable removes Network.enable.
  setup: Map<string, SetupCommand>
  // Frames reported by Page.frameAttached. Frames removed while detached never get frameDetached.
  frameIds: Set<string>
  // Document and url each frame showed last. A frame that navigated while detached never gets frameNavigated.
  loaderIds: Map<string, string>
  urls: Map<string, string>
  // Frames whose current document we reported ourselves. Chrome's own event for it can still arrive.
  announced: Set<string>
  reattachTimes: number[]
}

// Stops reattach loops when an extension re-injects its iframe immediately after every attach.
const MAX_REATTACHES_PER_WINDOW = 5
const REATTACH_WINDOW_MS = 5000

const REPLAYED_SETTERS = new Set([
  'Page.setLifecycleEventsEnabled',
  'Page.setInterceptFileChooserDialog',
  'Page.setBypassCSP',
  'Network.setExtraHTTPHeaders',
  'Network.setCacheDisabled',
  'Network.setBypassServiceWorker',
  'Network.emulateNetworkConditions',
  'Network.setUserAgentOverride',
  'Security.setIgnoreCertificateErrors',
  'Target.setAutoAttach',
])

// Only tabs with an entry are recorded, so late results for a disconnected tab are ignored.
const tabSessions = new Map<number, TabSession>()
let nextInitScriptId = 1

export function startTabSession(tabId: number): void {
  tabSessions.set(tabId, {
    setup: new Map(),
    frameIds: new Set(),
    loaderIds: new Map(),
    urls: new Map(),
    announced: new Set(),
    reattachTimes: [],
  })
}

export function endTabSession(tabId: number): void {
  tabSessions.delete(tabId)
}

export function tabSessionIds(): number[] {
  return [...tabSessions.keys()]
}

export function canReattach(tabId: number): boolean {
  const session = tabSessions.get(tabId)
  if (!session) {
    return false
  }
  const now = Date.now()
  session.reattachTimes = session.reattachTimes.filter((time) => {
    return now - time < REATTACH_WINDOW_MS
  })
  if (session.reattachTimes.length >= MAX_REATTACHES_PER_WINDOW) {
    return false
  }
  session.reattachTimes.push(now)
  return true
}

export function trackFrameEvent({ tabId, method, params }: { tabId: number; method: string; params: any }): void {
  const session = tabSessions.get(tabId)
  if (!session) {
    return
  }
  if (method === 'Page.frameAttached') {
    session.frameIds.add(params.frameId)
  }
  // A swapped frame became an OOPIF, its child session reports it from now on.
  if (method === 'Page.frameDetached') {
    session.frameIds.delete(params.frameId)
    session.loaderIds.delete(params.frameId)
    session.urls.delete(params.frameId)
    session.announced.delete(params.frameId)
  }
  if (method === 'Page.frameNavigated') {
    session.frameIds.add(params.frame.id)
    session.loaderIds.set(params.frame.id, params.frame.loaderId)
    session.urls.set(params.frame.id, frameUrl(params.frame))
    session.announced.delete(params.frame.id)
  }
  if (method === 'Page.navigatedWithinDocument') {
    session.urls.set(params.frameId, params.url)
  }
}

// True for Chrome's Page.frameNavigated of a document takeFrameChanges already reported. A second
// event for the same document would make Playwright forget that the document had loaded.
export function isAnnouncedDocument({ tabId, frame }: { tabId: number; frame: Protocol.Page.Frame }): boolean {
  const session = tabSessions.get(tabId)
  if (!session?.announced.has(frame.id) || session.loaderIds.get(frame.id) !== frame.loaderId) {
    return false
  }
  session.announced.delete(frame.id)
  return true
}

function frameUrl(frame: Protocol.Page.Frame): string {
  return frame.url + (frame.urlFragment ?? '')
}

// Frames Playwright read with Page.getFrameTree, which sends no frameAttached for them.
export function trackFrameTree({ tabId, frameTree }: { tabId: number; frameTree: Protocol.Page.FrameTree }): void {
  const session = tabSessions.get(tabId)
  if (!session) {
    return
  }
  const visit = (tree: Protocol.Page.FrameTree) => {
    session.frameIds.add(tree.frame.id)
    session.loaderIds.set(tree.frame.id, tree.frame.loaderId)
    session.urls.set(tree.frame.id, frameUrl(tree.frame))
    ;(tree.childFrames ?? []).forEach(visit)
  }
  visit(frameTree)
}

type FrameChange = {
  method: 'Page.frameAttached' | 'Page.frameNavigated' | 'Page.navigatedWithinDocument'
  params: object
}

// Events Playwright missed while the tab was detached: frames that appeared, and frames that
// show another document than the one Playwright saw last. Parents come before their children.
export function takeFrameChanges({
  tabId,
  frameTree,
  navigated,
}: {
  tabId: number
  frameTree: Protocol.Page.FrameTree
  // The main frame committed a document while detached (seen through chrome.webNavigation)
  navigated: boolean
}): FrameChange[] {
  const session = tabSessions.get(tabId)
  if (!session) {
    return []
  }
  const changes: FrameChange[] = []
  const visit = (tree: Protocol.Page.FrameTree, parentFrameId?: string, parentNavigated = false) => {
    const { frame } = tree
    // Playwright learns the main frame from the target itself, and forgets a frame's children
    // when the frame navigates
    const known = !parentFrameId || (!parentNavigated && session.frameIds.has(frame.id))
    const lastLoaderId = known ? session.loaderIds.get(frame.id) : undefined
    if (!known && parentFrameId) {
      changes.push({ method: 'Page.frameAttached', params: { frameId: frame.id, parentFrameId } })
    }
    const newDocument = lastLoaderId ? lastLoaderId !== frame.loaderId : !parentFrameId && navigated
    const lastUrl = session.urls.get(frame.id)
    if (!known || newDocument) {
      changes.push({ method: 'Page.frameNavigated', params: { frame, type: 'Navigation' } })
      session.announced.add(frame.id)
    } else if (lastUrl !== undefined && lastUrl !== frameUrl(frame)) {
      // history.pushState and fragment changes keep the document
      changes.push({ method: 'Page.navigatedWithinDocument', params: { frameId: frame.id, url: frameUrl(frame) } })
    }
    session.frameIds.add(frame.id)
    session.loaderIds.set(frame.id, frame.loaderId)
    session.urls.set(frame.id, frameUrl(frame))
    ;(tree.childFrames ?? []).forEach((child) => {
      visit(child, frame.id, !known || newDocument)
    })
  }
  visit(frameTree)
  return changes
}

// Returns frames Playwright still knows that are missing from the reattached frame tree.
export function takeRemovedFrameIds({ tabId, frameTree }: { tabId: number; frameTree: Protocol.Page.FrameTree }): string[] {
  const frameIds = tabSessions.get(tabId)?.frameIds
  if (!frameIds) {
    return []
  }
  const collectIds = (tree: Protocol.Page.FrameTree): string[] => {
    return [tree.frame.id, ...(tree.childFrames ?? []).flatMap(collectIds)]
  }
  const liveFrameIds = new Set(collectIds(frameTree))
  const removed = [...frameIds].filter((frameId) => {
    return !liveFrameIds.has(frameId)
  })
  removed.forEach((frameId) => {
    frameIds.delete(frameId)
  })
  return removed
}

// Translates the stable init script id Playwright got into the current Chrome identifier.
export function resolveSetupParams({
  tabId,
  method,
  params,
}: {
  tabId: number
  method: string
  params?: object
}): object | undefined {
  if (method !== 'Page.removeScriptToEvaluateOnNewDocument') {
    return params
  }
  const { identifier } = params as Protocol.Page.RemoveScriptToEvaluateOnNewDocumentRequest
  const scriptIdentifier = tabSessions.get(tabId)?.setup.get(`script:${identifier}`)?.scriptIdentifier
  return scriptIdentifier ? { ...params, identifier: scriptIdentifier } : params
}

// Records a successful init script. Playwright gets a stable id, Chrome's id changes on reattach.
export function recordInitScript({
  tabId,
  params,
  result,
}: {
  tabId: number
  params?: object
  result: Protocol.Page.AddScriptToEvaluateOnNewDocumentResponse
}): Protocol.Page.AddScriptToEvaluateOnNewDocumentResponse {
  const setup = tabSessions.get(tabId)?.setup
  if (!setup) {
    return result
  }
  const identifier = `playwriter-${nextInitScriptId++}`
  // The script already ran in the current documents, replay only for future ones.
  setup.set(`script:${identifier}`, {
    method: 'Page.addScriptToEvaluateOnNewDocument',
    params: { ...params, runImmediately: false },
    scriptIdentifier: result.identifier,
  })
  return { ...result, identifier }
}

// Records a successful root-session setup command (all others are ignored).
export function recordSetupCommand({ tabId, method, params }: { tabId: number; method: string; params?: object }): void {
  const setup = tabSessions.get(tabId)?.setup
  if (!setup) {
    return
  }
  // Delete before set so the latest command moves to the end and replays in order.
  const put = (key: string) => {
    setup.delete(key)
    setup.set(key, { method, params })
  }
  const [domain, command = ''] = method.split('.')
  const fields = params as { identifier?: string; name?: string } | undefined

  if (command === 'enable') {
    put(domain)
  } else if (command === 'disable') {
    setup.delete(domain)
  } else if (method === 'Page.removeScriptToEvaluateOnNewDocument') {
    setup.delete(`script:${fields?.identifier}`)
  } else if (method === 'Runtime.addBinding') {
    put(`binding:${fields?.name}`)
  } else if (method === 'Runtime.removeBinding') {
    setup.delete(`binding:${fields?.name}`)
  } else if (domain === 'Emulation' && command.startsWith('clear')) {
    setup.delete(`Emulation.set${command.slice('clear'.length)}`)
  } else if ((domain === 'Emulation' && command.startsWith('set')) || REPLAYED_SETTERS.has(method)) {
    put(method)
  }
}

// Best effort: one rejected setter must not drop the page. Returns the failed commands.
export async function replaySetup({
  tabId,
  send,
  newDocument = false,
  documentChanged = () => false,
}: {
  tabId: number
  send: (method: string, params?: object) => Promise<unknown>
  // The page loaded a document while detached, which no init script has run in yet
  newDocument?: boolean
  // Whether the main frame committed a document since this reattach began
  documentChanged?: () => boolean
}): Promise<Array<{ method: string; error: Error }>> {
  const failures: Array<{ method: string; error: Error }> = []
  const addInitScript = async (command: SetupCommand, runImmediately: boolean): Promise<string> => {
    const params = runImmediately ? { ...command.params, runImmediately: true } : command.params
    const result = (await send(command.method, params)) as Protocol.Page.AddScriptToEvaluateOnNewDocumentResponse
    return result.identifier
  }
  for (const command of tabSessions.get(tabId)?.setup.values() ?? []) {
    try {
      if (command.method !== 'Page.addScriptToEvaluateOnNewDocument') {
        await send(command.method, command.params)
        continue
      }
      // Chrome runs an init script only in documents created after the script was added. A
      // document that loaded while detached, or that commits during this replay, needs it run now.
      const runImmediately = newDocument || documentChanged()
      command.scriptIdentifier = await addInitScript(command, runImmediately)
      if (!runImmediately && documentChanged()) {
        // The document committed while the command was in flight, so whether it has the script
        // is unknown. Running it twice is safer than never: add it again, then drop the first.
        const first = command.scriptIdentifier
        command.scriptIdentifier = await addInitScript(command, true)
        await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: first })
      }
    } catch (error) {
      failures.push({ method: command.method, error: error instanceof Error ? error : new Error(String(error)) })
    }
  }
  return failures
}

// Chrome sends the lifecycle events of the current documents again. Needed after reporting a
// navigation late, because Playwright resets a frame's load state on Page.frameNavigated.
export async function replayLifecycleEvents({
  tabId,
  send,
}: {
  tabId: number
  send: (method: string, params?: object) => Promise<unknown>
}): Promise<void> {
  const command = tabSessions.get(tabId)?.setup.get('Page.setLifecycleEventsEnabled')
  if (command) {
    await send(command.method, command.params)
  }
}
