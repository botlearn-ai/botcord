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
