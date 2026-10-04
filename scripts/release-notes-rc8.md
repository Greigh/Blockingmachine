## Blockingmachine v1.0.0-rc.8

Eighth release candidate for Blockingmachine 1.0. The spine of this release is **proving it on the daemon**: the Deploy Hub's recipes are now rehearsed against live software rather than audited against documentation — and the first rehearsal caught a real silent-failure bug in the Pi-hole integration. The release also takes Electron Forge 8 (audit findings 9 → 6), closes three more open flags, and puts a mirrored weekly ledger cut onto Forgejo Actions. The full monorepo suite is green.

### Highlights since RC 7

- **Pi-hole v6 actually works — it used to report "triggered" with nothing running (`@blockingmachine/electron-app`).** The pane advertised "v5 & v6" while the code emitted only the v5 `?auth=` query shape, which on a v6 daemon lands on the admin SPA and answers HTTP 200 HTML — "Gravity update triggered" while gravity never ran. `piholeApi.ts` now detects the API flavor from the configured URL and drives v6's real session flow (`POST /api/auth` → `X-FTL-SID` → `POST /api/action/gravity` → `DELETE /api/auth`), while a v5-shape URL answered by the SPA fails honestly instead of reporting success. Verified on a live Pi-hole v6.3 container down to the daemon's own gravity log.

- **`sinkholeFetch` is hardened for embedded-daemon HTTP (`@blockingmachine/electron-app`).** Fresh single-use sockets plus `insecureHTTPParser` — FTL's CivetWeb writes bytes after its chunk terminator that poison strict-parser socket reuse; `respondOnHeaders` so endpoints like gravity that stream a long-lived log don't hold the sync open; and `x-ftl-sid` joins the credential headers stripped across cross-origin redirects.

- **Four more Deploy recipes rehearsed on live daemons (`@blockingmachine/electron-app`).** Privoxy 4.2.0 (block page, last-match-wins child escape, `show-status`, and a URL in `actionsfile` proven *fatal to startup*), AdGuard Home v0.107.71 (subscribe → the app's exact refresh call → `0.0.0.0` through AGH's DNS; `validateFilterURL` refuses feeds AGH's own upstreams can't resolve), Technitium v15.6 (subscription → `forceUpdateBlockLists` → NXDOMAIN), plus dnsmasq 2.93's SIGHUP asymmetry and Unbound 1.26.1's full verdict matrix from the previous rehearsal batch. Seven targets now have a running check; the remainder (OpenWrt, OPNsense, pfBlockerNG, AdGuard Desktop, Shadowrocket) are documented hardware-bound.

- **BIND null-zone exports delegate allowed subdomains for real (`@blockingmachine/core`, flag 20).** Allowed children under a sinkholed zone now escape via genuine `IN NS` referrals in per-parent delegation files — proven against live `named` — instead of staying unhonoured exceptions.

- **Three more audit flags closed (`docs/open-flags.md`).** Flag 51 (shared-hosting apex install — `registrableDomainOf` now uses the classifier's suffix decomposition), flag 41 (first-party brand tokens refused at corpus admission; accepted tokens 8,107 → 4,157 measured on the compiled-tier dry-run), flag 20 (the delegation above). The hub's compile handler also emits `hotlist.txt` from the picked ledger — the route was allowlisted but nothing ever wrote it.

- **Electron Forge 8 (`@blockingmachine/electron-app`).** The deliberate major upgrade flag 52 named: `npm audit` went 9 → 6 high findings, all the same unpatched `braces` advisory via `webpack-dev-server` — dev-toolchain only, nothing shipped. The real breaking surface was handled (`index.cjs` main entry, object-signature `afterPrune`, `.cjs` bundle emit, `junk@^4`) and packaging verified end-to-end — staged asar, app boot, feed 200.

- **Forgejo Actions parity.** The Forgejo CI got the same build-before-test ordering fix GitHub needed (run 310 caught a real webpack `extensionAlias` failure `tsc` can't see; run 312 green), and a mirrored weekly ledger cut workflow now runs Mondays 04:17 UTC on the injected `GITHUB_TOKEN` — no new actions or secrets.

### Downloads & Assets

| Asset | Description |
|---|---|
| [`Blockingmachine-1.0.0-rc.8-arm64.dmg`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.8/Blockingmachine-1.0.0-rc.8-arm64.dmg) | macOS Apple Silicon installer |
| [`Blockingmachine-darwin-arm64-1.0.0-rc.8.zip`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.8/Blockingmachine-darwin-arm64-1.0.0-rc.8.zip) | macOS Apple Silicon standalone app |
| [`blockingmachine-core-1.0.0-rc.8.tgz`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.8/blockingmachine-core-1.0.0-rc.8.tgz) | Core library NPM package |
| [`blockingmachine-cli-1.0.0-rc.8.tgz`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.8/blockingmachine-cli-1.0.0-rc.8.tgz) | CLI executable NPM package |
| [`blockingmachine-chrome-mv3-v1.0.0.zip`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.8/blockingmachine-chrome-mv3-v1.0.0.zip) | Chrome Manifest V3 extension |
| [`blockingmachine-firefox-mv3-v1.0.0.zip`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.8/blockingmachine-firefox-mv3-v1.0.0.zip) | Firefox Manifest V3 extension |
| [`SHA256SUMS.txt`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.8/SHA256SUMS.txt) | SHA-256 verification checksums |

### Verification Checksums (SHA-256)

```text
ed36c215a6e7e4934b063c28a5b69192d5776a74e249e9256288a999af00238c  Blockingmachine-1.0.0-rc.8-arm64.dmg
cfb8cc276447c4eec7f837a01dab931d5130cdd51678f81234a714a0bc18d6c7  Blockingmachine-darwin-arm64-1.0.0-rc.8.zip
df4d0e546b813aee169700562f3e7e58cbfbaa05b97ec9d5c465269646440722  Blockingmachine-linux-x64-1.0.0-rc.8.zip
e6788f15fa265238ed66dae036e7cda851db3a765e3b3afaa57754447f8b5698  Blockingmachine-win32-x64-1.0.0-rc.8.zip
7d5b45113246c89dca811ee5d053b63d41d4010a93b2695d34e90bbf963808d4  Blockingmachine.dmg
233379857e44aac88a451cd48d3e8e8f40a880b3d5b504ff109095e39c1317f0  BlockingmachineSetup.exe
e64afdc1d4097f80aab1358aa16ac7eddaf0ec71b5736523fc7a381b2fec65f9  blockingmachine-1.0.0.rc.8-1.x86_64.rpm
06f179048f8f57acdfccfb1570e644a2419e5e42a20b032c5a564325849563b9  blockingmachine-chrome-mv3-v1.0.0.zip
209f668d0b4b4bf0343b06d6fd38d5e283477b0b95d986b33d6e889e529844c9  blockingmachine-cli-1.0.0-rc.8.tgz
eb1f525b54563014efd7191f1efeb6b51abf5be246b17f3993d2be3ce2b0e158  blockingmachine-core-1.0.0-rc.8.tgz
c7323a1ede3b482c8d8175ca021fe9c862d7281eb17128918c63b04362032448  blockingmachine-firefox-mv3-v1.0.0.zip
cb1d591f3b42f43861908f985d56cfd602a49eec87f9274f74e9eb5518a1dcd5  blockingmachine_1.0.0.rc.8_amd64.deb
```
