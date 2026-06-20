# GitHub App setup, ID disambiguation, and the JWT smoke test

## App creation checklist (human, browser)

github.com/settings/apps/new:

- Name: `<project>-relay` (globally unique-ish)
- Homepage URL: the repo URL (required field, anything works)
- **Webhook → uncheck "Active"** (the relay polls locally; no webhook, no URL needed)
- Repository permissions: `Contents: Read and write`, `Pull requests: Read and write`
  (Metadata: Read-only is added automatically). **Do NOT add `Workflows: Read and
  write`.** Withholding it is the point: GitHub then rejects any push touching
  `.github/workflows/**`, so the agent pipeline cannot modify its own CI gate (the
  merge backstop). The relay surfaces that as a `REFUSE`; land workflow changes with
  a human-credentialed push instead (see SKILL.md "Relay policy decisions"). Add it
  only if you deliberately want agent-authored workflow edits.
- "Where can this GitHub App be installed?" → **Only on this account**
- After create: note the **App ID** (General tab), **Generate a private key**
  (.pem downloads), then left menu **Install App** → **Only select repositories**
  → the target repo.

Key storage (host, outside every container mount):

```bash
mkdir -p ~/.config/<project>-relay && chmod 700 ~/.config/<project>-relay
mv ~/Downloads/<project>-relay.*.private-key.pem ~/.config/<project>-relay/app.pem
chmod 600 ~/.config/<project>-relay/app.pem
openssl rsa -in ~/.config/<project>-relay/app.pem -check -noout   # "RSA key ok"
```

## `config.env` template

```bash
# <project> relay config. The private key stays in app.pem — no secrets in this file.
APP_ID=<from the App settings General tab>
INSTALLATION_ID=<see below>
REPO=<owner>/<repo>
REPO_PATH=/path/to/host/checkout
PRIVATE_KEY_PATH=/home/<user>/.config/<project>-relay/app.pem
BRANCH_PREFIX=claude/
```

## ⚠️ App ID vs Installation ID (a real time-sink)

Three different numbers look alike:

| Number | Where you see it | Used for |
|---|---|---|
| **App ID** (~7 digits) | App settings page, "App ID:" on the General tab | `iss` claim of the JWT |
| **Installation ID** (~9 digits) | the URL after installing: `github.com/settings/installations/<ID>` | `POST /app/installations/<ID>/access_tokens` |
| Client ID (`Iv23...`) | App settings | not needed for this relay |

Failure signature when they're swapped: `GET /app` with a JWT whose `iss` is the
installation id returns **404 "Integration not found"** (GitHub resolves `iss`
before checking the signature).

Dead ends when trying to look IDs up by API: `GET /apps/<slug>` returns 404 for
private ("only on this account") apps, and `GET /user/installations` requires a
GitHub App *user* token (a gh OAuth token gets 403). The reliable way is the
smoke test below — it needs only the key + App ID, and *returns* the installation id.

## JWT smoke test (verifies key↔App pairing, fetches Installation ID)

```bash
node -e '
const fs=require("fs"),crypto=require("crypto");
const key=fs.readFileSync(process.env.HOME+"/.config/<project>-relay/app.pem");
const b64=o=>Buffer.from(JSON.stringify(o)).toString("base64url");
const now=Math.floor(Date.now()/1000);
const unsigned=`${b64({alg:"RS256",typ:"JWT"})}.${b64({iat:now-60,exp:now+540,iss:"<APP_ID>"})}`;
const sig=crypto.createSign("RSA-SHA256").update(unsigned).end().sign(key,"base64url");
const h={Authorization:`Bearer ${unsigned}.${sig}`,Accept:"application/vnd.github+json",
  "X-GitHub-Api-Version":"2022-11-28","User-Agent":"relay-check"};
(async()=>{
  const app=await (await fetch("https://api.github.com/app",{headers:h})).json();
  console.log("app:",JSON.stringify({id:app.id,slug:app.slug,permissions:app.permissions}));
  const inst=await (await fetch("https://api.github.com/app/installations",{headers:h})).json();
  for(const i of inst) console.log("installation:",JSON.stringify({id:i.id,
    account:i.account&&i.account.login,repository_selection:i.repository_selection}));
})();
'
```

Expected: `app:` echoes your App ID/slug and exactly the permissions you granted;
`installation:` shows `repository_selection: "selected"` and the **id to put in
config.env**.

## Sandbox-side companion settings

- `.claude/settings.json`: allow `Bash(git add:*)`, `Bash(git commit:*)`,
  `Bash(git checkout:*)`, `Bash(git switch:*)`; keep `Bash(git push:*)` in `deny`.
- Container git identity (distinguishable agent authorship):
  `git config --global user.name "Claude (<project> sandbox)"`,
  `git config --global user.email "noreply@anthropic.com"`.
- Convention: agent work lives on `claude/<topic>` branches; the relay ignores
  everything else.
