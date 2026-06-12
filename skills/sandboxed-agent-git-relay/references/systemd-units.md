# systemd user units for the relay

Place under `~/.config/systemd/user/`. Then:

```bash
systemctl --user daemon-reload
systemctl --user enable --now <project>-relay.timer
systemctl --user list-timers <project>-relay.timer   # NEXT should be ~60s out
journalctl --user -u <project>-relay.service -f      # watch ticks
```

## `<project>-relay.service`

```ini
[Unit]
Description=<project> push/PR relay

[Service]
Type=oneshot
EnvironmentFile=%h/.config/<project>-relay/config.env
# Use an absolute node path: systemd user env has no version-manager PATH.
# (mise example below; adjust for nvm/asdf/system node.)
ExecStart=%h/.local/share/mise/installs/node/lts/bin/node %h/.config/<project>-relay/relay.mjs
```

## `<project>-relay.timer`

```ini
[Unit]
Description=<project> relay tick (60s)

[Timer]
OnStartupSec=30s
OnUnitActiveSec=60s
AccuracySec=10s

[Install]
WantedBy=timers.target
```

Gotchas:

- **`AccuracySec=10s` is load-bearing.** The systemd default accuracy is 1 minute,
  and coalescing turns `OnUnitActiveSec=60s` into ~2-minute real intervals.
- `Type=oneshot` + timer never overlaps runs: the timer won't re-fire while the
  service is still active.
- User units run only while the user is logged in. For a headless/always-on host:
  `loginctl enable-linger <user>`.
- Validate OUTSIDE systemd first (`set -a; . config.env; set +a; node relay.mjs`),
  then once via `systemctl --user start <project>-relay.service` and check the
  journal — the systemd environment (PATH, HOME expansion) is where surprises live.
