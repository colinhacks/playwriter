---
'playwriter': minor
---

Let a password manager's menu open while the user has the tab during a handoff.

Chrome detaches the debugger from a tab when another extension's iframe loads in it, so Playwriter removes those iframes to stay attached, and a password manager's menu never opened on an attached tab. While a handoff card is showing and no agent code is running, the extension now leaves the iframe in place and stays detached. It reattaches when the page navigates, the user presses Done, the menu closes or the agent runs its next command, and waits such as `waitForHandoff` resolve on the same page.

Outside a handoff the iframe is still removed. When it sits in a closed shadow root on an otherwise empty element, the extension now removes that element, so Proton Pass builds a new menu on the next click. Before, its icon did nothing until the page reloaded.
