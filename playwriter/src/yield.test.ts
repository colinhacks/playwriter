import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { chromium, type Page } from '@xmorse/playwright-core'
import path from 'node:path'
import { getCdpUrl } from './utils.js'
import { getCDPSessionForPage } from './cdp-session.js'
import { PlaywrightExecutor } from './executor.js'
import {
  setupTestContext,
  cleanupTestContext,
  getExtensionServiceWorker,
  type TestContext,
  createSimpleServer,
} from './test-utils.js'
import './test-declarations.js'

const TEST_PORT = 19931
// Stand-in for a password manager, built like Proton Pass's inline menu: one menu iframe
// (chrome-extension://) in a closed shadow root, created when a login form is detected.
// It rebuilds its UI when its host element is removed, not when only the iframe is.
const PASSWORD_MANAGER_PATH = path.resolve('../extension/test-fixtures/password-manager')

const form = `<input autocomplete="username" id="user"><input type="password" autocomplete="current-password" id="pass">`
const ROUTES = {
  '/': '<!doctype html><html><body><h1>Home</h1></body></html>',
  '/login': `<!doctype html><html><body><h1>Sign in</h1>${form}
    <button id="submit" onclick="location.href='/app'">Sign in</button></body></html>`,
  // Signs in without loading a document, like a single-page app
  '/spa': `<!doctype html><html><body><h1>Sign in</h1>${form}
    <button id="submit" onclick="history.pushState({}, '', '/spa/app'); document.querySelector('h1').textContent = 'Signed in'">Sign in</button>
    <button id="done" onclick="document.body.dataset.done = '1'; document.dispatchEvent(new CustomEvent('playwriter:resume'))">Done</button></body></html>`,
  // Asks Playwriter back, then loads the next document `window.__delay` ms later
  '/race': `<!doctype html><html><body><h1>Sign in</h1>${form}
    <button id="go" onclick="document.dispatchEvent(new CustomEvent('playwriter:resume')); setTimeout(() => { location.href = '/app' }, window.__delay)">Go</button></body></html>`,
  '/app': '<!doctype html><html><body><h1>Signed in</h1></body></html>',
}

type MenuState = { pmReady?: string; pmOpen?: string; pmCreated?: string }

describe('Yielding a tab to another extension', () => {
  let testCtx: TestContext | null = null

  beforeAll(async () => {
    testCtx = await setupTestContext({
      port: TEST_PORT,
      tempDirPrefix: 'pw-yield-test-',
      toggleExtension: true,
      additionalExtensions: [PASSWORD_MANAGER_PATH],
    })
  }, 600000)

  afterAll(async () => {
    await cleanupTestContext(testCtx)
    testCtx = null
  })

  // `user` is Playwright's direct CDP pipe. Chrome applies no chrome.debugger restrictions to
  // it, so the tests use it as the person at the keyboard: it never goes through Playwriter.
  // `agent` is the same tab seen through the relay and the extension.
  const open = async (route: string) => {
    const browserContext = testCtx!.browserContext
    const serviceWorker = await getExtensionServiceWorker(browserContext)
    const server = await createSimpleServer({ routes: ROUTES })
    const user = await browserContext.newPage()
    await user.goto(server.baseUrl, { waitUntil: 'domcontentloaded' })
    await user.bringToFront()
    await serviceWorker.evaluate(async () => {
      await globalThis.toggleExtensionForActiveTab()
    })
    const browser = await chromium.connectOverCDP(getCdpUrl({ port: TEST_PORT }))
    const agent = browser
      .contexts()[0]
      .pages()
      .find((p) => p.url().startsWith(server.baseUrl))!
    await agent.goto(`${server.baseUrl}${route}`)
    // The manager created its menu frame at form detection, and Playwriter removed it to stay attached
    await user.waitForFunction(() => document.documentElement.dataset.pmCreated === '1')
    await expect.poll(() => menuFrame(user)).toBeUndefined()
    const cdp = await getCDPSessionForPage({ page: agent })
    return {
      user,
      agent,
      server,
      setYield: async (enabled: boolean) => {
        return (await cdp.send('Playwriter.setYield' as never, { enabled } as never)) as unknown as { yielded: boolean }
      },
      resume: async () => {
        return (await cdp.send('Playwriter.resume' as never)) as unknown as { resumed: boolean }
      },
      yielded: async () => {
        return (await serviceWorker.evaluate(() => globalThis.getYieldState())).yielded.length
      },
      close: async () => {
        await browser.close()
        await user.bringToFront()
        await serviceWorker
          .evaluate(async () => {
            await globalThis.toggleExtensionForActiveTab()
          })
          .catch(() => {})
        await user.close()
        await server.close()
      },
    }
  }

  const menuFrame = (page: Page) => page.frames().find((frame) => frame.url().startsWith('chrome-extension://'))
  const menuState = async (page: Page): Promise<MenuState> => {
    return await page.evaluate(() => ({ ...document.documentElement.dataset }))
  }
  // The person opens the manager's menu from the icon in the field and picks their login
  const fillWithMenu = async (user: Page) => {
    await user.click('[data-pm-icon]')
    await user.waitForFunction(() => document.documentElement.dataset.pmOpen === '1', undefined, { timeout: 5000 })
    await menuFrame(user)!.click('#fill')
    await user.waitForFunction(() => document.querySelector('#pass').value !== '')
  }
  const settle = (name: string, promise: Promise<unknown>) => {
    return promise.then(
      () => `${name}: resolved`,
      (error: Error) => `${name}: rejected: ${error.message.split('\n')[0]}`,
    )
  }

  it('without yield mode the menu never opens, and the agent keeps the tab', async () => {
    const tab = await open('/login')
    try {
      await tab.user.click('[data-pm-icon]')
      await tab.user.waitForTimeout(2500)
      // The manager rebuilt its frame on the click, and Playwriter removed it again
      const state = await menuState(tab.user)
      expect({
        created: state.pmCreated,
        open: state.pmOpen,
        frame: Boolean(menuFrame(tab.user)),
        yielded: await tab.yielded(),
      }).toMatchInlineSnapshot(`
        {
          "created": "2",
          "frame": false,
          "open": "0",
          "yielded": 0,
        }
      `)
      expect(await tab.agent.evaluate(() => document.querySelector('h1')?.textContent)).toBe('Sign in')
    } finally {
      await tab.close()
    }
  }, 60000)

  it('in yield mode the user signs in with the menu, and pending waits resolve after it', async () => {
    const tab = await open('/login')
    try {
      // Session state Chrome drops on detach
      await tab.agent.setViewportSize({ width: 777, height: 555 })
      await tab.agent.addInitScript(() => {
        ;(window as any).__initScriptRan = true
      })
      await tab.agent.exposeFunction('double', (n: number) => {
        return n * 2
      })

      await tab.setYield(true)
      const waits = [
        // what waitForHandoff runs for a URL RegExp
        settle(
          'waitForFunction',
          tab.agent.waitForFunction(() => window.location.pathname === '/app', undefined, {
            polling: 500,
            timeout: 15000,
          }),
        ),
        settle('waitForURL', tab.agent.waitForURL(/\/app$/, { timeout: 15000 })),
        settle('locator.waitFor', tab.agent.locator('h1', { hasText: 'Signed in' }).waitFor({ timeout: 15000 })),
      ]

      await fillWithMenu(tab.user)
      expect({
        yielded: await tab.yielded(),
        user: await tab.user.inputValue('#user'),
        pass: await tab.user.inputValue('#pass'),
        agentPageClosed: tab.agent.isClosed(),
      }).toMatchInlineSnapshot(`
        {
          "agentPageClosed": false,
          "pass": "correct horse",
          "user": "ada@example.com",
          "yielded": 1,
        }
      `)

      await tab.user.click('#submit')
      expect(await Promise.all(waits)).toMatchInlineSnapshot(`
        [
          "waitForFunction: resolved",
          "waitForURL: resolved",
          "locator.waitFor: resolved",
        ]
      `)
      expect({
        yielded: await tab.yielded(),
        path: new URL(tab.agent.url()).pathname,
        frames: tab.agent.frames().length,
        ...(await tab.agent.evaluate(async () => {
          return {
            title: document.querySelector('h1')?.textContent,
            width: window.innerWidth,
            doubled: await (window as any).double(21),
            initScriptRan: (window as any).__initScriptRan,
          }
        })),
      }).toMatchInlineSnapshot(`
        {
          "doubled": 42,
          "frames": 1,
          "initScriptRan": true,
          "path": "/app",
          "title": "Signed in",
          "width": 777,
          "yielded": 0,
        }
      `)
      await tab.setYield(false)
    } finally {
      await tab.close()
    }
  }, 60000)

  it('a yielded tab comes back when the menu closes, the client asks, the page asks or the url changes', async () => {
    const tab = await open('/spa')
    try {
      await tab.setYield(true)
      const openMenu = async () => {
        await tab.user.click('[data-pm-icon]')
        await tab.user.waitForFunction(() => document.documentElement.dataset.pmOpen === '1', undefined, {
          timeout: 5000,
        })
      }

      // 1. While the menu is open the tab stays away, however long the user takes
      await openMenu()
      await tab.user.waitForTimeout(5000)
      expect(await tab.yielded()).toBe(1)
      // Playwright has no execution context for a yielded tab, so an evaluate waits and sends nothing
      const blocked = await Promise.race([
        tab.agent.evaluate(() => 'ran'),
        new Promise((resolve) => {
          setTimeout(resolve, 1500, 'still waiting')
        }),
      ])
      expect(blocked).toBe('still waiting')
      // Once the user picked a login the menu hides, and the tab comes back by itself
      await menuFrame(tab.user)!.click('#fill')
      await expect.poll(() => tab.yielded(), { timeout: 5000 }).toBe(0)
      expect(await tab.agent.evaluate(() => document.querySelector('#pass').value)).toBe('correct horse')

      // 2. The client asks
      await openMenu()
      expect(await tab.yielded()).toBe(1)
      expect(await tab.resume()).toEqual({ resumed: true })
      expect(await tab.agent.evaluate(() => document.querySelector('h1')?.textContent)).toBe('Sign in')

      // 3. The page asks, like handoff's Done button
      await openMenu()
      const done = settle(
        'done',
        tab.agent.waitForFunction(() => document.body.dataset.done === '1', undefined, {
          polling: 500,
          timeout: 15000,
        }),
      )
      await tab.user.click('#done')
      expect(await done).toBe('done: resolved')

      // 4. The url changes without a new document
      await openMenu()
      expect(await tab.yielded()).toBe(1)
      const signedIn = settle('url', tab.agent.waitForURL(/\/spa\/app$/, { timeout: 15000 }))
      await tab.user.click('#submit')
      expect(await signedIn).toBe('url: resolved')
      expect({
        yielded: await tab.yielded(),
        path: new URL(tab.agent.url()).pathname,
        title: await tab.agent.evaluate(() => document.querySelector('h1')?.textContent),
      }).toMatchInlineSnapshot(`
        {
          "path": "/spa/app",
          "title": "Signed in",
          "yielded": 0,
        }
      `)
    } finally {
      await tab.close()
    }
  }, 90000)

  // The user can submit the form just as the tab comes back, for example when the menu closes
  // after filling. Chrome then commits the next document while the session is being restored.
  it('a document that loads while the tab is taken back is set up like any other', async () => {
    const round = async (delay: number) => {
      const tab = await open('/race')
      try {
        await tab.agent.addInitScript(() => {
          ;(window as any).__initScriptRuns = ((window as any).__initScriptRuns || 0) + 1
        })
        await tab.agent.exposeFunction('double', (n: number) => {
          return n * 2
        })
        await tab.setYield(true)
        await tab.user.evaluate((delay) => {
          ;(window as any).__delay = delay
        }, delay)
        await tab.user.click('[data-pm-icon]')
        await tab.user.waitForFunction(() => document.documentElement.dataset.pmOpen === '1', undefined, {
          timeout: 5000,
        })
        const waits = [
          settle('waitForURL', tab.agent.waitForURL(/\/app$/, { timeout: 10000 })),
          settle('locator.waitFor', tab.agent.locator('h1', { hasText: 'Signed in' }).waitFor({ timeout: 10000 })),
        ]
        await tab.user.click('#go')
        return {
          delay,
          waits: await Promise.all(waits),
          load: await settle('load', tab.agent.waitForLoadState('load', { timeout: 5000 })),
          page: await Promise.race([
            tab.agent.evaluate(async () => {
              return {
                initScriptRuns: (window as any).__initScriptRuns,
                doubled: await (window as any).double?.(21),
              }
            }),
            new Promise((resolve) => {
              setTimeout(resolve, 5000, 'evaluate timed out')
            }),
          ]),
        }
      } finally {
        await tab.close()
      }
    }
    // The session takes tens of milliseconds to restore: these land before, during and after it
    const delays = [0, 8, 16, 40]
    const results = []
    for (const delay of delays) {
      results.push(await round(delay))
    }
    expect(results).toEqual(
      delays.map((delay) => {
        return {
          delay,
          waits: ['waitForURL: resolved', 'locator.waitFor: resolved'],
          load: 'load: resolved',
          page: { initScriptRuns: 1, doubled: 42 },
        }
      }),
    )
  }, 120000)

  it('handoff: the user signs in with the menu while waitForHandoff waits', async () => {
    const browserContext = testCtx!.browserContext
    const serviceWorker = await getExtensionServiceWorker(browserContext)
    const server = await createSimpleServer({ routes: ROUTES })
    const user = await browserContext.newPage()
    await user.goto(server.baseUrl, { waitUntil: 'domcontentloaded' })
    await user.bringToFront()
    await serviceWorker.evaluate(async () => {
      await globalThis.toggleExtensionForActiveTab()
    })
    const executor = new PlaywrightExecutor({
      cdpConfig: { port: TEST_PORT },
      logger: { log: () => {}, error: () => {} },
    })
    const yieldState = async () => {
      const state = await serviceWorker.evaluate(() => globalThis.getYieldState())
      return { yieldMode: state.yieldMode.length, yielded: state.yielded.length }
    }
    try {
      const shown = await executor.execute(`
        state.page = context.pages().find((p) => p.url().startsWith(${JSON.stringify(server.baseUrl)}))
        await state.page.goto(${JSON.stringify(`${server.baseUrl}/login`)})
        await handoff({ page: state.page, message: 'Sign in with your own account.' })
      `)
      expect(shown.isError).toBe(false)
      // Between executes the tab is the user's
      expect(await yieldState()).toEqual({ yieldMode: 1, yielded: 0 })

      const waiting = executor.execute(
        `await waitForHandoff({ page: state.page, until: /\\/app$/ }); return state.page.url()`,
        { timeout: 30000 },
      )
      await user.waitForTimeout(500)

      await fillWithMenu(user)
      expect({
        ...(await yieldState()),
        pass: await user.inputValue('#pass'),
        card: await user.locator('#__playwriter_handoff').count(),
      }).toMatchInlineSnapshot(`
        {
          "card": 1,
          "pass": "correct horse",
          "yieldMode": 1,
          "yielded": 1,
        }
      `)

      await user.click('#submit')
      const waited = await waiting
      expect({ isError: waited.isError, text: waited.text.replace(/:\d+/, ':<port>') }).toMatchInlineSnapshot(`
        {
          "isError": false,
          "text": "[return value] http://127.0.0.1:<port>/app",
        }
      `)

      // The handoff is over: the agent has its tab back and keeps it
      const after = await executor.execute(
        `return await state.page.evaluate(() => document.querySelector('h1').textContent)`,
      )
      expect({ text: after.text, ...(await yieldState()) }).toMatchInlineSnapshot(`
        {
          "text": "[return value] Signed in",
          "yieldMode": 0,
          "yielded": 0,
        }
      `)
    } finally {
      await user.bringToFront()
      await serviceWorker
        .evaluate(async () => {
          await globalThis.toggleExtensionForActiveTab()
        })
        .catch(() => {})
      await user.close()
      await server.close()
    }
  }, 90000)

  it('handoff: Done on a manual card reaches the agent from a yielded tab', async () => {
    const browserContext = testCtx!.browserContext
    const serviceWorker = await getExtensionServiceWorker(browserContext)
    const server = await createSimpleServer({ routes: ROUTES })
    const user = await browserContext.newPage()
    await user.goto(server.baseUrl, { waitUntil: 'domcontentloaded' })
    await user.bringToFront()
    await serviceWorker.evaluate(async () => {
      await globalThis.toggleExtensionForActiveTab()
    })
    const executor = new PlaywrightExecutor({
      cdpConfig: { port: TEST_PORT },
      logger: { log: () => {}, error: () => {} },
    })
    try {
      await executor.execute(`
        state.page = context.pages().find((p) => p.url().startsWith(${JSON.stringify(server.baseUrl)}))
        await state.page.goto(${JSON.stringify(`${server.baseUrl}/login`)})
        await handoff({ page: state.page, message: 'Fill in your password, then press Done.', manual: true })
      `)
      const waiting = executor.execute(
        `await waitForHandoff({ page: state.page }); return await state.page.inputValue('#pass')`,
        { timeout: 30000 },
      )
      await user.waitForTimeout(500)

      // The menu is still open when the user presses Done
      await user.click('[data-pm-icon]')
      await user.waitForFunction(() => document.documentElement.dataset.pmOpen === '1', undefined, { timeout: 5000 })
      await user.fill('#pass', 'typed by hand')
      expect((await serviceWorker.evaluate(() => globalThis.getYieldState())).yielded.length).toBe(1)
      await user.locator('#__playwriter_handoff button').click()

      const waited = await waiting
      expect({ isError: waited.isError, text: waited.text }).toMatchInlineSnapshot(`
        {
          "isError": false,
          "text": "[return value] typed by hand",
        }
      `)
    } finally {
      await user.bringToFront()
      await serviceWorker
        .evaluate(async () => {
          await globalThis.toggleExtensionForActiveTab()
        })
        .catch(() => {})
      await user.close()
      await server.close()
    }
  }, 90000)
})
