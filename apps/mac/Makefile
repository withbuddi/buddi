SCHEME := buddi
CONFIGURATION := Debug
PROJECT := buddi.xcodeproj
DERIVED_DATA := build
APP_PATH := $(DERIVED_DATA)/Build/Products/$(CONFIGURATION)/buddi.app

.DEFAULT_GOAL := help

.PHONY: help generate resolve fetch build run stop clean logs open-xcode release notarize dmg version

RELEASE_APP := $(DERIVED_DATA)/Build/Products/Release/buddi.app

# The app is versioned as the buddi release in Payload/ (what `make fetch` put
# there): that version for display, and the numbers-and-dots form Sparkle
# compares as CFBundleVersion, from the one script the release workflow uses too.
# Lazy (=): read when a target runs, after a `make fetch` in an earlier call.
APP_VERSION = $(shell plutil -extract version raw -o - Payload/buddi/current/package.json 2>/dev/null)
BUNDLE_VERSION = $(if $(APP_VERSION),$(shell node ../../scripts/release/bundle-version.mjs "$(APP_VERSION)"))
VERSION_FLAGS = $(if $(BUNDLE_VERSION),MARKETING_VERSION=$(APP_VERSION) CURRENT_PROJECT_VERSION=$(BUNDLE_VERSION))
DMG_PATH = $(DERIVED_DATA)/buddi-$(APP_VERSION).dmg

# The buddi release the app carries: the npm version, `latest` by default.
# make fetch VERSION=0.1.0-pre.38
VERSION ?= $(shell npm view @withbuddi/buddi version 2>/dev/null)
# The Node line buddi is tested on (CI's node-version).
NODE_MAJOR := 22

# Signing follows the environment, like Shotcrisp's CI: with DEVELOPMENT_TEAM set,
# Developer ID; without it, Debug signs to run locally (ad-hoc, see project.yml).
ifneq ($(strip $(DEVELOPMENT_TEAM)),)
TEAM_FLAGS := DEVELOPMENT_TEAM=$(DEVELOPMENT_TEAM)
DEBUG_SIGN := CODE_SIGN_IDENTITY="Developer ID Application" $(TEAM_FLAGS)
else
TEAM_FLAGS :=
DEBUG_SIGN := CODE_SIGN_IDENTITY=- DEVELOPMENT_TEAM=
endif

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-12s\033[0m %s\n", $$1, $$2}'

generate: ## Regenerate buddi.xcodeproj from project.yml
	xcodegen generate

resolve: generate ## Resolve Swift package dependencies
	xcodebuild -resolvePackageDependencies -project $(PROJECT) -scheme $(SCHEME)

# Node (universal, checked against SHASUMS256.txt) and the @withbuddi/buddi
# tarball with both embedded-Postgres architectures (checked against the npm
# integrity in each packument) into Payload/. The build copies Payload/ into
# Contents/Resources. See scripts/fetch-payload.sh.
fetch: ## Download Node LTS and the buddi release (VERSION=x.y.z) into Payload/
	@test -n "$(VERSION)" || { echo "fetch: name a version: make fetch VERSION=0.1.0-pre.38"; exit 1; }
	scripts/fetch-payload.sh "$(VERSION)" "$(NODE_MAJOR)"

# CODE_SIGN_INJECT_BASE_ENTITLEMENTS=NO strips the auto-injected get-task-allow
# debug entitlement, as in Shotcrisp: debug builds behave like release ones.
build: generate ## Build the app (ad-hoc signed, or Developer ID when DEVELOPMENT_TEAM is set)
	xcodebuild -project $(PROJECT) -scheme $(SCHEME) -configuration $(CONFIGURATION) \
		-derivedDataPath $(DERIVED_DATA) \
		CODE_SIGN_INJECT_BASE_ENTITLEMENTS=NO \
		$(DEBUG_SIGN) $(VERSION_FLAGS) \
		build

# Runs the build in place (no copy to /Applications: this is a service, and a second
# registered copy would start at login too). For a throwaway instance next to a real
# one, pass a data directory and a port; both reach the app through `open --env`:
#   make run BUDDI_DATA_DIR=$(mktemp -d) BUDDI_WEB_PORT=4517
RUN_ENV := $(if $(BUDDI_DATA_DIR),--env BUDDI_DATA_DIR=$(BUDDI_DATA_DIR)) $(if $(BUDDI_WEB_PORT),--env BUDDI_WEB_PORT=$(BUDDI_WEB_PORT))
run: build stop ## Build and launch from build/ (BUDDI_DATA_DIR / BUDDI_WEB_PORT for a scratch instance)
	open -n $(RUN_ENV) "$(APP_PATH)"

# Notarization requires secure timestamps on every signature; local builds default to
# --timestamp=none, so the flag must be forced here.
release: generate ## Release build, signed with secure timestamp (notarization-ready)
	xcodebuild -project $(PROJECT) -scheme $(SCHEME) -configuration Release \
		-derivedDataPath $(DERIVED_DATA) \
		CODE_SIGN_INJECT_BASE_ENTITLEMENTS=NO \
		OTHER_CODE_SIGN_FLAGS=--timestamp \
		$(TEAM_FLAGS) $(VERSION_FLAGS) \
		build

version: ## Print the buddi version in Payload/ and the CFBundleVersion it maps to
	@test -n "$(APP_VERSION)" || { echo "version: Payload/ is empty; run make fetch first" >&2; exit 1; }
	@echo "$(APP_VERSION) $(BUNDLE_VERSION)"

# Sparkle's nested helpers keep Sparkle's own signature when Xcode embeds the
# framework; the notary service requires OUR Developer ID + secure timestamp on
# every Mach-O. Deep-sign inside-out, then re-sign the framework and the app
# (the app re-sign must re-apply our entitlements). Downloader.xpc keeps its
# own (sandbox) entitlements via --preserve-metadata.
#
# Contents/Resources holds Mach-O too: Node (with the hardened-runtime exceptions
# V8 needs, App/node.entitlements) and both embedded-Postgres trees (binaries
# and dylibs). Every one of them is signed before the app is sealed.
SPARKLE_FW := $(RELEASE_APP)/Contents/Frameworks/Sparkle.framework
SIGN := codesign --force --options runtime --timestamp --sign "Developer ID Application"

# Requires APPLE_ID, DEVELOPMENT_TEAM, NOTARIZE_PASSWORD in the environment (set in ~/.zshrc).
notarize: release ## Submit release build to Apple notary service, staple ticket
	$(SIGN) "$(SPARKLE_FW)/Versions/B/XPCServices/Installer.xpc"
	$(SIGN) --preserve-metadata=entitlements "$(SPARKLE_FW)/Versions/B/XPCServices/Downloader.xpc"
	$(SIGN) "$(SPARKLE_FW)/Versions/B/Autoupdate"
	$(SIGN) "$(SPARKLE_FW)/Versions/B/Updater.app"
	$(SIGN) "$(SPARKLE_FW)"
	find "$(RELEASE_APP)/Contents/Resources/buddi" -type f \( -name '*.dylib' -o -name '*.so' -o -name '*.node' -o -perm -u+x \) -print0 \
		| xargs -0 file | grep 'Mach-O' | cut -d: -f1 | while read -r bin; do $(SIGN) "$$bin"; done
	$(SIGN) --entitlements App/node.entitlements "$(RELEASE_APP)/Contents/Resources/runtime/node"
	$(SIGN) --entitlements App/buddi.entitlements "$(RELEASE_APP)"
	codesign --verify --deep --strict "$(RELEASE_APP)"
	ditto -c -k --keepParent "$(RELEASE_APP)" "$(DERIVED_DATA)/buddi.zip"
	xcrun notarytool submit "$(DERIVED_DATA)/buddi.zip" \
		--apple-id "$$APPLE_ID" --team-id "$$DEVELOPMENT_TEAM" --password "$$NOTARIZE_PASSWORD" \
		--wait
	xcrun stapler staple "$(RELEASE_APP)"
	spctl -a -vv "$(RELEASE_APP)"

# Expects the stapled app from `make notarize`. The DMG itself is notarized and stapled
# too, so the downloaded file passes Gatekeeper before the app is even dragged out.
dmg: ## Package the stapled release app into a notarized drag-to-Applications DMG
	rm -rf $(DERIVED_DATA)/dmg-staging "$(DMG_PATH)"
	mkdir -p $(DERIVED_DATA)/dmg-staging
	ditto "$(RELEASE_APP)" "$(DERIVED_DATA)/dmg-staging/buddi.app"
	ln -s /Applications "$(DERIVED_DATA)/dmg-staging/Applications"
	hdiutil create -volname "buddi" -srcfolder "$(DERIVED_DATA)/dmg-staging" -ov -format UDZO "$(DMG_PATH)"
	codesign --force --sign "Developer ID Application" --timestamp "$(DMG_PATH)"
	xcrun notarytool submit "$(DMG_PATH)" \
		--apple-id "$$APPLE_ID" --team-id "$$DEVELOPMENT_TEAM" --password "$$NOTARIZE_PASSWORD" \
		--wait
	xcrun stapler staple "$(DMG_PATH)"

# A real Quit, not pkill: the app stops buddi (gateway, then Postgres) on its way out.
stop: ## Quit a running instance of the app (buddi stops with it)
	@osascript -e 'tell application id "com.withbuddi.app" to quit' 2>/dev/null || true
	@while pgrep -x buddi >/dev/null; do sleep 0.5; done

clean: ## Remove local build artifacts (keeps Payload/)
	rm -rf $(DERIVED_DATA)/Build $(DERIVED_DATA)/Logs $(DERIVED_DATA)/*.dmg $(DERIVED_DATA)/*.zip $(DERIVED_DATA)/dmg-staging

logs: ## Show recent system log output from the app
	/usr/bin/log show --style compact --predicate 'process == "buddi"' --last 5m

open-xcode: generate ## Open the project in Xcode
	open $(PROJECT)
