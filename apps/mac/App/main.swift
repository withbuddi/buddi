import AppKit

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
// A regular app: a dock icon, the menu bar and the window (the status item stays for status).
app.setActivationPolicy(.regular)
app.run()
