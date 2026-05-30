# Authenticating Claude Code inside the container

The image already has `@anthropic-ai/claude-code` installed globally. You authenticate **once**; the token lands in `/home/node/.claude`, which is a named volume, so it survives `docker compose down` (but not `down -v`).

## The flow

```sh
docker compose up -d
docker compose exec dev zsh
# in-container:
claude
```

On first run Claude Code prints a browser sign-in URL.

**The trap:** the container has no browser, and the OAuth localhost callback can't reach it. So:

1. **Copy the URL** printed in the container.
2. Open it in a **browser on your host**, sign in to your Claude / Anthropic Console account, approve.
3. The browser shows a **code to paste back**.
4. Paste it at the `Paste code here if prompted` prompt in the container terminal.

That completes auth. Confirm with `/status` inside a `claude` session — it should show the account and the model (e.g. `claude-opus-4-x`).

## Provider variants

- **Anthropic API / Claude subscription** → the browser flow above.
- **Bedrock / Vertex / Foundry** → no browser. Pass credentials as environment variables in `docker-compose.yml` under `environment:` (or via an `env_file`), and make sure the provider's API endpoint is in the firewall allowlist instead of `api.anthropic.com`. Never bind-mount host cloud credential files into the container.

## Persistence & re-auth

| Action | Auth state |
|---|---|
| `exit` / Ctrl-D | kept (container still running) |
| `docker compose stop` / `down` | kept (named volume `claude-config`) |
| `docker compose down -v` | **wiped** — re-authenticate |
| `docker compose build` (image rebuild) | kept (volume is separate from the image) |

## Long-lived token alternative (CI / headless)

For non-interactive use, generate a long-lived token on a machine that *has* a browser:

```sh
claude setup-token   # prints a CLAUDE_CODE_OAUTH_TOKEN
```

Then inject it into the container via `environment:` / `env_file:` instead of doing the browser flow. Treat it as a secret — keep it in a gitignored `.env`, not in `docker-compose.yml`.
