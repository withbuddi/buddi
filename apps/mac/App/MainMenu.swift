import AppKit

/// The menu bar, laid out as every Mac app's: buddi, File, Edit, View, Window,
/// Help. Items that act in the dashboard reach it through `MainWindowController`
/// (a route, or the page's own shortcut); the standard ones (Edit, Window, Hide)
/// go down the responder chain to the web view and the window as usual.
@MainActor
enum MainMenu {
    static func build(target: AppDelegate) -> NSMenu {
        let bar = NSMenu()

        // buddi
        let app = submenu(in: bar, title: "buddi")
        item(app, "About buddi", #selector(AppDelegate.showAbout), target: target)
        item(app, "Check for Updates…", #selector(AppDelegate.checkForUpdatesFromMenu), target: target)
        app.addItem(.separator())
        item(app, "Settings…", #selector(AppDelegate.openSettings), key: ",", target: target)
        item(app, "Lock", #selector(AppDelegate.lockDashboard), key: "l", modifiers: [.control, .command], target: target)
        app.addItem(.separator())
        let services = NSMenu(title: "Services")
        app.addItem(withTitle: "Services", action: nil, keyEquivalent: "").submenu = services
        NSApp.servicesMenu = services
        app.addItem(.separator())
        item(app, "Hide buddi", #selector(NSApplication.hide(_:)), key: "h")
        item(app, "Hide Others", #selector(NSApplication.hideOtherApplications(_:)), key: "h", modifiers: [.option, .command])
        item(app, "Show All", #selector(NSApplication.unhideAllApplications(_:)))
        app.addItem(.separator())
        item(app, "Quit buddi", #selector(NSApplication.terminate(_:)), key: "q")

        // File
        let file = submenu(in: bar, title: "File")
        item(file, "New Conversation", #selector(AppDelegate.newConversation), key: "n", target: target)
        item(file, "Open in Browser", #selector(AppDelegate.openInBrowser), key: "o", modifiers: [.option, .command], target: target)
        file.addItem(.separator())
        item(file, "Close Window", #selector(NSWindow.performClose(_:)), key: "w")

        // Edit: the web view answers all of these itself.
        let edit = submenu(in: bar, title: "Edit")
        item(edit, "Undo", Selector(("undo:")), key: "z")
        item(edit, "Redo", Selector(("redo:")), key: "z", modifiers: [.shift, .command])
        edit.addItem(.separator())
        item(edit, "Cut", #selector(NSText.cut(_:)), key: "x")
        item(edit, "Copy", #selector(NSText.copy(_:)), key: "c")
        item(edit, "Paste", #selector(NSText.paste(_:)), key: "v")
        item(edit, "Paste and Match Style", #selector(NSTextView.pasteAsPlainText(_:)), key: "v", modifiers: [.option, .shift, .command])
        item(edit, "Delete", #selector(NSText.delete(_:)))
        item(edit, "Select All", #selector(NSText.selectAll(_:)), key: "a")
        edit.addItem(.separator())
        let find = NSMenu(title: "Find")
        edit.addItem(withTitle: "Find", action: nil, keyEquivalent: "").submenu = find
        item(find, "Find…", #selector(AppDelegate.showFind), key: "f", target: target)
        item(find, "Find Next", #selector(AppDelegate.findNext), key: "g", target: target)
        item(find, "Find Previous", #selector(AppDelegate.findPrevious), key: "g", modifiers: [.shift, .command], target: target)
        // macOS adds Start Dictation and Emoji & Symbols to a menu titled "Edit".

        // View
        let view = submenu(in: bar, title: "View")
        item(view, "Reload", #selector(AppDelegate.reloadDashboard), key: "r", target: target)
        view.addItem(.separator())
        item(view, "Actual Size", #selector(AppDelegate.zoomActual), key: "0", target: target)
        item(view, "Zoom In", #selector(AppDelegate.zoomIn), key: "+", target: target)
        item(view, "Zoom Out", #selector(AppDelegate.zoomOut), key: "-", target: target)
        view.addItem(.separator())
        item(view, "Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), key: "f", modifiers: [.control, .command])

        // Window
        let window = submenu(in: bar, title: "Window")
        item(window, "Minimize", #selector(NSWindow.performMiniaturize(_:)), key: "m")
        item(window, "Zoom", #selector(NSWindow.performZoom(_:)))
        window.addItem(.separator())
        item(window, "buddi", #selector(AppDelegate.showMainWindow), key: "1", target: target)
        window.addItem(.separator())
        item(window, "Bring All to Front", #selector(NSApplication.arrangeInFront(_:)))
        NSApp.windowsMenu = window

        // Help
        let help = submenu(in: bar, title: "Help")
        item(help, "buddi Help", #selector(AppDelegate.openHelp), target: target)
        item(help, "Report a Problem…", #selector(AppDelegate.reportProblem), target: target)
        NSApp.helpMenu = help

        return bar
    }

    private static func submenu(in bar: NSMenu, title: String) -> NSMenu {
        let menu = NSMenu(title: title)
        bar.addItem(withTitle: title, action: nil, keyEquivalent: "").submenu = menu
        return menu
    }

    @discardableResult
    private static func item(_ menu: NSMenu, _ title: String, _ action: Selector, key: String = "",
                             modifiers: NSEvent.ModifierFlags = .command, target: AnyObject? = nil) -> NSMenuItem {
        let item = menu.addItem(withTitle: title, action: action, keyEquivalent: key)
        if !key.isEmpty { item.keyEquivalentModifierMask = modifiers }
        item.target = target
        return item
    }
}
