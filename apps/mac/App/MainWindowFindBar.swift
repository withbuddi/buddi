import AppKit
import WebKit

/// Edit → Find (⌘F) for the dashboard: a small native bar over the top right
/// of the page, searching with WKWebView's own `find`. Return finds the next
/// match, Shift-Return the previous one, Escape closes the bar.
@MainActor
final class MainWindowFindBar: NSVisualEffectView, NSSearchFieldDelegate {
    private weak var webView: WKWebView?
    private let field = NSSearchField()
    private let result = NSTextField(labelWithString: "")

    init(webView: WKWebView) {
        self.webView = webView
        super.init(frame: .zero)
        material = .popover
        blendingMode = .withinWindow
        state = .active
        wantsLayer = true
        layer?.cornerRadius = 10
        layer?.masksToBounds = true

        field.placeholderString = "Find in buddi"
        field.sendsWholeSearchString = true
        field.sendsSearchStringImmediately = false
        field.target = self
        field.action = #selector(search)
        field.delegate = self

        result.font = .systemFont(ofSize: 11)
        result.textColor = .secondaryLabelColor

        let previous = NSButton(image: NSImage(systemSymbolName: "chevron.left", accessibilityDescription: "Previous match")!,
                                target: self, action: #selector(findPrevious))
        let next = NSButton(image: NSImage(systemSymbolName: "chevron.right", accessibilityDescription: "Next match")!,
                            target: self, action: #selector(findNext))
        let done = NSButton(title: "Done", target: self, action: #selector(close))
        for button in [previous, next, done] {
            button.bezelStyle = .accessoryBarAction
            button.controlSize = .small
        }

        let row = NSStackView(views: [field, result, previous, next, done])
        row.orientation = .horizontal
        row.spacing = 6
        row.edgeInsets = NSEdgeInsets(top: 6, left: 8, bottom: 6, right: 8)
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        NSLayoutConstraint.activate([
            field.widthAnchor.constraint(equalToConstant: 220),
            row.leadingAnchor.constraint(equalTo: leadingAnchor),
            row.trailingAnchor.constraint(equalTo: trailingAnchor),
            row.topAnchor.constraint(equalTo: topAnchor),
            row.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
        isHidden = true
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func open() {
        isHidden = false
        window?.makeFirstResponder(field)
        field.selectText(nil)
    }

    @objc func findNext() { run(backwards: false) }
    @objc func findPrevious() { run(backwards: true) }

    @objc private func search() {
        let shift = NSApp.currentEvent?.modifierFlags.contains(.shift) ?? false
        run(backwards: shift)
    }

    @objc private func close() {
        isHidden = true
        result.stringValue = ""
        if let webView { window?.makeFirstResponder(webView) }
    }

    private func run(backwards: Bool) {
        guard let webView else { return }
        let text = field.stringValue
        guard !text.isEmpty else {
            if isHidden { open() }
            return
        }
        let configuration = WKFindConfiguration()
        configuration.backwards = backwards
        configuration.caseSensitive = false
        configuration.wraps = true
        webView.find(text, configuration: configuration) { [weak self] found in
            self?.result.stringValue = found.matchFound ? "" : "Not found"
        }
    }

    // Escape in the field closes the bar.
    func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        if selector == #selector(NSResponder.cancelOperation(_:)) {
            close()
            return true
        }
        return false
    }
}
