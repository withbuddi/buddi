### Fixture: the tail of a cloudflared release body, as Cloudflare publishes it.

The linux-amd64 line is the SHA-256 of the two-line script `#!/bin/sh` / `echo fake cloudflared`
the tests serve; the linux-arm64 line deliberately matches nothing.

### SHA256 Checksums:
```
cloudflared-amd64.pkg: 48d0d3b28b3b5d142490f57316981b65ae46fbbe33408c22b0a4a11b5242de50
cloudflared-linux-amd64: 3c1b003b78fa045b8453ee97e88c3f6f39f405468cfd58632f8d47061a2585df
cloudflared-linux-amd64.deb: bc073ef293d504cf5ac533bd0aa1c824ef6b4f358765ccaa6628a8a95cacb4b7
cloudflared-linux-arm64: 0000000000000000000000000000000000000000000000000000000000000000
cloudflared-windows-amd64.exe: f096265ec2fcbe9bb6e2d64268db167ced3fcbb83d894bdb9e2fcdb26f2ea7e2
```
