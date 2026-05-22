# BotCord Desktop

Tauri desktop control panel for the local BotCord daemon.

## Development

```bash
cd desktop
npm install
npm run web:dev
```

To run the full desktop shell, install Rust/Cargo and then run:

```bash
cd desktop
npm run dev
```

## What It Manages

- `botcord-daemon start --background`
- `botcord-daemon stop`
- `botcord-daemon status --json`
- daemon log tail from `~/.botcord/logs/daemon.log`
- macOS user service: `~/Library/LaunchAgents/chat.botcord.daemon.plist`
- Linux user service: `~/.config/systemd/user/chat.botcord.daemon.service`

The service uses `botcord-daemon start --foreground` so `launchd` or
`systemd --user` owns the process lifecycle.

When `botcord-daemon` is not already available, the desktop shell installs an
app-managed copy under `~/.botcord/daemon`, creates
`~/.botcord/bin/botcord-daemon`, and then starts it with the install token
minted by the authenticated Dashboard flow.

## macOS Release

Public macOS distribution is built by the `Publish Desktop DMG` GitHub Actions
workflow in `.github/workflows/publish-desktop-dmg.yml`. The workflow imports a
Developer ID Application certificate, builds the Tauri app, signs and notarizes
the DMG, notarizes and staples the zipped `.app`, validates both artifacts, and
uploads the DMG, zip, and SHA256 checksums to a GitHub Release.

### Apple Requirements

- Active Apple Developer Program membership for the distribution team.
- A Developer ID Application certificate for the Apple team that owns the
  `ai.ouraca.botcord` bundle identifier.
- An App Store Connect API key that can submit notarization requests for that
  Apple team.

Confirm the imported signing identity in the workflow logs matches the intended
Apple team before publishing a public release.

### Required GitHub Actions Secrets

Configure these repository secrets before running the workflow:

- `MAC_DEVELOPER_ID_APPLICATION_CERTIFICATE_BASE64`: base64-encoded `.p12`
  export of the Developer ID Application certificate and private key.
- `MAC_DEVELOPER_ID_APPLICATION_CERTIFICATE_PASSWORD`: password for the `.p12`
  certificate export.
- `APP_STORE_CONNECT_API_KEY_BASE64`: base64-encoded App Store Connect
  `AuthKey_<KEY_ID>.p8` private key.
- `APP_STORE_CONNECT_API_KEY_ID`: App Store Connect API key ID.
- `APP_STORE_CONNECT_API_ISSUER_ID`: App Store Connect issuer ID.

Create the base64 values on macOS with:

```bash
base64 -i DeveloperIDApplication.p12 | pbcopy
base64 -i AuthKey_<KEY_ID>.p8 | pbcopy
```

### Publishing Flow

1. Update `desktop/package.json` and `desktop/src-tauri/tauri.conf.json` to the
   desktop version being released.
2. Push a tag matching `desktop-v*` or `botcord-desktop-*`, or run `Publish
   Desktop DMG` manually from GitHub Actions.
3. For a manual run, use `main` or the release tag as `ref`; use a release tag
   such as `desktop-v0.1.0` or `botcord-desktop-beta` as `release_tag`.
4. Wait for the workflow to finish and confirm the Release includes:
   - `BotCord_<tag>_macos_<arch>.dmg`
   - `BotCord_<tag>_macos_<arch>.app.zip`
   - `SHA256SUMS.txt`
5. Confirm the workflow logs include passing `codesign --verify`, `xcrun
   stapler validate`, and `spctl` checks.
6. Install the DMG on a clean macOS machine and verify first launch, `botcord://`
   deep link registration, daemon install/start, and update or reinstall
   behavior.

Files in `desktop/release-assets-local/` are local test artifacts only. Do not
publish them unless they are rebuilt through the signed and notarized workflow.
