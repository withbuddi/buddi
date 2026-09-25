# A trial harness, not a distribution.
#
# What goes in is the release tarball and nothing else: no checkout, no pnpm,
# no build tools. The point is to meet the packaged install the way a stranger
# on a clean Linux machine would.
FROM node:22-bookworm-slim

# socat: `environment()` forces the gateway to bind 127.0.0.1 and that must
# not change, so reaching it from the host needs a forwarder inside the
# container rather than a wider bind.
#
# The rest are the shared libraries Chromium needs on Debian 12 — the
# `chromium` list `playwright install-deps chromium` installs (Playwright
# 1.63, the same for x64 and arm64), plus the fontconfig, freetype and one
# font family it adds so a page has glyphs to draw. A desktop distro already
# has every one of them; a slim image has none, and the trial should not be
# stricter than a real machine. With them, the wizard's browser step fetches
# Chromium, launches it once and says "Installed." here too.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      socat \
      libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcairo2 libcups2 \
      libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 libnspr4 libnss3 libpango-1.0-0 \
      libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 \
      libxrandr2 \
      libfontconfig1 libfreetype6 fonts-liberation \
 && rm -rf /var/lib/apt/lists/*

ARG TARBALL=buddi.tgz
COPY ${TARBALL} /tmp/buddi.tgz
# Install scripts stay off, optional dependencies stay **on**: the optional
# `@embedded-postgres/linux-<arch>` is how the managed cluster gets binaries
# for this container's architecture. The check below fails the build if the
# architecture the image will actually run as did not get its package.
RUN npm install -g --ignore-scripts --no-audit --no-fund /tmp/buddi.tgz \
 && rm /tmp/buddi.tgz \
 && node -e "const fs=require('fs'),p='/usr/local/lib/node_modules/buddi/node_modules/@embedded-postgres/linux-'+process.arch;fs.accessSync(p+'/native/bin/postgres');console.log('Postgres binaries: @embedded-postgres/linux-'+process.arch)"

# The owner is not root here either. `node` (uid 1000) already has a home; the
# data directory is created in the image so that the named volume mounted over
# it inherits this ownership and its 0700 mode.
RUN mkdir -p /home/node/.local/share/buddi \
 && chown -R node:node /home/node/.local \
 && chmod 700 /home/node/.local/share/buddi

USER node
WORKDIR /home/node
# No keychain on Linux; the file vault keeps its key beside its ciphertext in
# the data directory, which is that vault's trust boundary.
ENV BUDDI_VAULT=file
# The container is a place to run `buddi` in, not a service of its own.
CMD ["sleep", "infinity"]
