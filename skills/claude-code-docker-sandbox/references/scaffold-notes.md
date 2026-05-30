# Scaffolding a project non-interactively inside the container

When you bootstrap a framework *inside* the firewall'd container (`npx sv create`,
`npm create vite@latest`, `create-next-app`, ...), two classes of problem show up
that don't appear on a normal host.

## 1. Interactive prompts stall a non-TTY exec

If you run the scaffolder via `docker compose exec -T` (no TTY) or as a backgrounded
command, any interactive prompt the tool emits will hang forever or exit oddly —
the tool waits for input that can't arrive. **Drive every generator fully
non-interactively**, providing all answers as flags. If even one option is left
unspecified, the tool drops into a prompt and stalls.

## 2. Mutually-exclusive and required flags

Real examples from `sv` (the SvelteKit CLI, `npx sv create`) — the pattern
generalizes to other `create-*` tools:

- **`--no-add-ons` and `--add` cannot be combined.** Picking add-ons means you
  *don't* also pass the "skip add-ons" flag. Read the tool's "non-interactive
  usage" help (`<tool> create --help`) for which flags conflict.
- **A flag that takes sub-options still prompts if you omit them.** `--add tailwindcss`
  alone re-prompts "which plugins?". You must spell out `tailwindcss=plugins:none`
  (or `plugins:typography+forms`) to skip it. The rule: *set ALL options of every
  add-on you enable*, using the defaults shown in `--help`.

A known-good fully-non-interactive invocation (SvelteKit + TS + Tailwind +
Cloudflare Pages adapter + Claude Code MCP):

```sh
npx sv@latest create . \
  --template minimal --types ts \
  --add prettier eslint tailwindcss=plugins:none \
        sveltekit-adapter=adapter:cloudflare+cfTarget:pages \
        mcp=ide:claude-code+setup:local \
  --install npm --no-dir-check --no-download-check
```

## 3. Generator network needs must be in the allowlist

Scaffolders fetch from the npm registry (already allowed) but some also hit other
hosts (template tarballs on GitHub — allowed via the dynamic GitHub ranges — or a
framework-specific CDN). If a generator hangs on "downloading template", check
whether it's reaching a host that isn't in `init-firewall.sh`, and add it.

## 4. Post-scaffold steps that aren't obvious

- Some adapters generate types lazily. E.g. SvelteKit's Cloudflare adapter makes
  `npm run build` fail with `Types file not found at worker-configuration.d.ts`
  until you run the generate step (`npm run gen` → `wrangler types`) once. Run the
  project's `check`/`gen` script before assuming the scaffold is broken.
- The generator may name the project `workspace` (from the mount dir) — fix
  `package.json` `name` afterward.

## 5. Editing files: host vs container

The bind mount means files the generator writes inside the container appear on the
host immediately. Edit them with your host editor; no rebuild needed. Only changes
to `.docker/*` or `docker-compose.yml` require `docker compose build` / recreate.
