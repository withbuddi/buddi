import AppKit

/// What the window shows while there is no dashboard to show: buddi starting,
/// updating, or needing attention. Native, in the kit's colours, so the
/// window never opens on a blank white page or a browser error.
@MainActor
final class MainWindowPlaceholder: NSView {
    enum Mode: Equatable {
        case starting(String)
        case attention(String, canRestart: Bool)
        /// Another installation's supervisor holds the data folder (npm's service).
        case anotherBuddi(canTakeOver: Bool)
    }

    var onRestart: (() -> Void)?
    var onShowLogs: (() -> Void)?
    var onTakeOver: (() -> Void)?

    private let face = NSImageView()
    private let title = NSTextField(labelWithString: "")
    private let detail = NSTextField(wrappingLabelWithString: "")
    private let spinner = NSProgressIndicator()
    private let restartButton = NSButton(title: "Restart buddi", target: nil, action: nil)
    private let logsButton = NSButton(title: "Show Logs", target: nil, action: nil)
    private let takeOverButton = NSButton(title: "Take Over", target: nil, action: nil)

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true

        face.image = NSImage(named: "Mascot") ?? NSApp.applicationIconImage
        face.imageScaling = .scaleProportionallyUpOrDown
        face.translatesAutoresizingMaskIntoConstraints = false

        title.font = .systemFont(ofSize: 17, weight: .semibold)
        title.textColor = Kit.text
        title.alignment = .center

        detail.font = .systemFont(ofSize: 13)
        detail.textColor = Kit.textMuted
        detail.alignment = .center
        detail.preferredMaxLayoutWidth = 380

        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.isDisplayedWhenStopped = false

        restartButton.target = self
        restartButton.action = #selector(restart)
        restartButton.bezelStyle = .push
        restartButton.keyEquivalent = "\r"
        logsButton.target = self
        logsButton.action = #selector(showLogs)
        logsButton.bezelStyle = .push
        takeOverButton.target = self
        takeOverButton.action = #selector(takeOver)
        takeOverButton.bezelStyle = .push

        // Actions on the right, the primary one last (the kit's rule and macOS's).
        let buttons = NSStackView(views: [logsButton, restartButton, takeOverButton])
        buttons.orientation = .horizontal
        buttons.spacing = 8

        let stack = NSStackView(views: [face, title, detail, spinner, buttons])
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 12
        stack.setCustomSpacing(20, after: face)
        stack.setCustomSpacing(20, after: detail)
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            face.widthAnchor.constraint(equalToConstant: 112),
            face.heightAnchor.constraint(equalToConstant: 112),
            detail.widthAnchor.constraint(lessThanOrEqualToConstant: 380),
            stack.centerXAnchor.constraint(equalTo: centerXAnchor),
            // A little above the middle, where the eye lands.
            stack.centerYAnchor.constraint(equalTo: centerYAnchor, constant: -24),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -24),
        ])
        show(.starting("Starting buddi…"))
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func updateLayer() {
        layer?.backgroundColor = Kit.background.cgColor
    }

    override var wantsUpdateLayer: Bool { true }

    func show(_ mode: Mode) {
        switch mode {
        case .starting(let text):
            title.stringValue = text
            detail.stringValue = ""
            detail.isHidden = true
            spinner.isHidden = false
            spinner.startAnimation(nil)
            restartButton.superview?.isHidden = true
        case .anotherBuddi(let canTakeOver):
            let words = SupervisorPolicy.anotherBuddi(canTakeOver: canTakeOver)
            title.stringValue = words.title
            detail.stringValue = words.detail
            detail.isHidden = false
            spinner.stopAnimation(nil)
            spinner.isHidden = true
            restartButton.superview?.isHidden = false
            restartButton.isHidden = true
            restartButton.keyEquivalent = ""
            takeOverButton.isHidden = !canTakeOver
            takeOverButton.keyEquivalent = canTakeOver ? "\r" : ""
        case .attention(let reason, let canRestart):
            title.stringValue = "buddi needs attention"
            detail.stringValue = reason
            detail.isHidden = false
            spinner.stopAnimation(nil)
            spinner.isHidden = true
            restartButton.superview?.isHidden = false
            restartButton.isHidden = !canRestart
            restartButton.keyEquivalent = "\r"
            takeOverButton.isHidden = true
            takeOverButton.keyEquivalent = ""
        }
        needsDisplay = true
    }

    @objc private func restart() { onRestart?() }
    @objc private func showLogs() { onShowLogs?() }
    @objc private func takeOver() { onTakeOver?() }
}
