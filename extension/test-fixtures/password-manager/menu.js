chrome.runtime.sendMessage({ type: 'pm-ready' })
document.getElementById('fill').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'pm-fill' })
})
