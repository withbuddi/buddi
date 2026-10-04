import AppKit
import ServiceManagement

/// Start at login via SMAppService: the app itself is the login item, and the app
/// starts buddi. Adapted from Shotcrisp, without its one-time offer — buddi is a
/// background service, so the menu's checkbox is the whole interface.
@MainActor
enum LaunchAtLogin {
    static var isEnabled: Bool {
        SMAppService.mainApp.status == .enabled
    }

    /// macOS can hold the registration for the owner's approval in System Settings.
    static var needsApproval: Bool {
        SMAppService.mainApp.status == .requiresApproval
    }

    static func setEnabled(_ enabled: Bool) {
        do {
            if enabled {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
        } catch {
            NSLog("buddi: start-at-login \(enabled ? "register" : "unregister") failed: \(error)")
            let alert = NSAlert()
            alert.messageText = enabled ? "buddi could not add itself to your login items" : "buddi could not remove itself from your login items"
            alert.informativeText = "\(error.localizedDescription)\n\nYou can change it in System Settings → General → Login Items."
            alert.runModal()
        }
        if needsApproval {
            SMAppService.openSystemSettingsLoginItems()
        }
    }
}
