// Relays messages from the menu iframe to the content script of the tab that holds it.
chrome.runtime.onInstalled.addListener(() => {})
chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.tab?.id !== undefined && sender.frameId !== 0) {
    chrome.tabs.sendMessage(sender.tab.id, message, { frameId: 0 }).catch(() => {})
  }
})
