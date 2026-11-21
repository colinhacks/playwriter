// Built like Proton Pass's inline menu (applications/pass-extension, services/inline):
// - one menu iframe per page, created when a login form is detected and reused for every field
// - the iframe lives in a closed shadow root on a host element appended to <body>
// - removing the host makes the extension rebuild it, removing only the iframe goes unnoticed
// State is mirrored to <html data-pm-*> so a test can read it from the page.
const state = { host: null, root: null, iframe: null, ready: false }

const report = () => {
  const html = document.documentElement
  html.dataset.pmIframe = state.iframe?.isConnected ? '1' : '0'
  html.dataset.pmReady = state.ready ? '1' : '0'
  html.dataset.pmOpen = state.iframe?.isConnected && state.iframe.style.display === 'block' ? '1' : '0'
}

const ensureRoot = () => {
  if (state.host?.isConnected) {
    return
  }
  state.host = document.createElement('div')
  state.host.setAttribute('data-pm-root', '')
  state.root = state.host.attachShadow({ mode: 'closed' })
  state.iframe = null
  state.ready = false
  document.body.appendChild(state.host)
}

const attachMenu = () => {
  ensureRoot()
  if (state.iframe) {
    return
  }
  const iframe = document.createElement('iframe')
  iframe.src = chrome.runtime.getURL('menu.html')
  iframe.style.cssText =
    'display:none;position:fixed;top:120px;left:20px;width:220px;height:40px;border:1px solid #888;z-index:2147483647'
  state.root.appendChild(iframe)
  state.iframe = iframe
  document.documentElement.dataset.pmCreated = String(Number(document.documentElement.dataset.pmCreated || 0) + 1)
  report()
}

const openMenu = async () => {
  attachMenu()
  for (let i = 0; i < 100 && !state.ready; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  if (!state.ready) {
    return
  }
  state.iframe.style.display = 'block'
  report()
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'pm-ready') {
    state.ready = true
  }
  if (message.type === 'pm-fill') {
    const user = document.querySelector('input[autocomplete="username"]')
    const password = document.querySelector('input[type="password"]')
    if (user) {
      user.value = 'ada@example.com'
    }
    if (password) {
      password.value = 'correct horse'
    }
    state.iframe.style.display = 'none'
  }
  report()
})

const detect = () => {
  const field = document.querySelector('input[type="password"]')
  if (!field || document.querySelector('[data-pm-icon]')) {
    return
  }
  const icon = document.createElement('button')
  icon.type = 'button'
  icon.textContent = 'PM'
  icon.setAttribute('data-pm-icon', '')
  icon.addEventListener('click', () => {
    void openMenu()
  })
  field.after(icon)
  // Pre-created at form detection, before any user action
  attachMenu()
}

new MutationObserver(() => {
  if (state.host && !state.host.isConnected) {
    state.host = null
    ensureRoot()
    report()
  }
  // Forms a page adds later are detected too
  detect()
}).observe(document.documentElement, { childList: true, subtree: true })

detect()
report()
