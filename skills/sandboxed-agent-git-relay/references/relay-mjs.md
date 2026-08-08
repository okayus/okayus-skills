# relay.mjs — full template

Place at `~/.config/<project>-relay/relay.mjs` (OUTSIDE the repo — the repo is
sandbox-writable). Plain Node ESM, no dependencies, functions only. Reads its
parameters from the environment (systemd `EnvironmentFile=` loads `config.env`).

```js
// <project> push/PR relay
// Detects commits on claude/* branches in the bind-mounted repo and relays them
// to GitHub with a 1h App installation token. Policy enforced here, outside the
// sandbox boundary:
//   - only refs under BRANCH_PREFIX are ever pushed (main is structurally out of reach)
//   - never force (exact refspec; diverged remote -> REFUSE + log)
//   - token exists only in this tick's memory and the git child's env, never on disk
//   - merge happens ONLY on an explicit "Relay-Merge: yes" trailer in the HEAD
//     commit (squash; the ruleset enforces CI green server-side — a too-early
//     attempt gets 405 and is retried next tick)

import { readFileSync } from "node:fs";
import { createSign } from "node:crypto";
import { execFileSync } from "node:child_process";

const env = (key) => {
  const value = process.env[key];
  if (!value) throw new Error(`missing env: ${key}`);
  return value;
};

const CONFIG = {
  appId: env("APP_ID"),
  installationId: env("INSTALLATION_ID"),
  repo: env("REPO"), // owner/name
  repoPath: env("REPO_PATH"),
  keyPath: env("PRIVATE_KEY_PATH"),
  branchPrefix: env("BRANCH_PREFIX"), // e.g. "claude/"
};

const log = (...args) => console.log(new Date().toISOString(), ...args);

const git = (args, extraEnv = null) =>
  execFileSync("git", ["-C", CONFIG.repoPath, ...args], {
    encoding: "utf8",
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");

const appJwt = () => {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url({
    iat: now - 60,
    exp: now + 300, // App JWTs max 10min; 5 is plenty
    iss: CONFIG.appId,
  })}`;
  const signature = createSign("RSA-SHA256")
    .update(unsigned)
    .end()
    .sign(readFileSync(CONFIG.keyPath), "base64url");
  return `${unsigned}.${signature}`;
};

const githubApi = async (method, path, body, token) => {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "<project>-relay",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return res.status === 204 ? null : res.json();
};

// Down-scope the installation token further (defense in depth)
const mintInstallationToken = async () => {
  const repoShortName = CONFIG.repo.split("/")[1];
  const data = await githubApi(
    "POST",
    `/app/installations/${CONFIG.installationId}/access_tokens`,
    { repositories: [repoShortName], permissions: { contents: "write", pull_requests: "write" } },
    appJwt(),
  );
  return data.token;
};

const localAgentBranches = () => {
  const out = git([
    "for-each-ref",
    "--format=%(refname:short) %(objectname)",
    `refs/heads/${CONFIG.branchPrefix}`,
  ]);
  if (!out) return [];
  return out.split("\n").map((line) => {
    const [name, sha] = line.split(" ");
    return { name, sha };
  });
};

const remoteSha = (branch) => {
  try {
    return git(["rev-parse", "--verify", `refs/remotes/origin/${branch}`]);
  } catch {
    return null;
  }
};

// is `a` an ancestor of `b` (i.e. push would be fast-forward)?
const isAncestor = (a, b) => {
  try {
    git(["merge-base", "--is-ancestor", a, b]);
    return true;
  } catch {
    return false;
  }
};

// three-dot diff vs origin/main: filters empty new branches.
// WARNING: this does NOT detect a squash merge. A three-dot diff shows the
// branch-side changes, so after the branch is squash-merged (its commits never
// become ancestors of main) the diff stays non-empty and the branch looks
// "unmerged" forever. Filtering squash residue is isTipAlreadyMerged's job.
const hasDiffAgainstMain = (branch) => {
  try {
    git(["diff", "--quiet", `origin/main...${branch}`]);
    return false;
  } catch {
    return true;
  }
};

// Has this tip SHA already landed via a merged PR? Because squash merge leaves
// the branch's commits out of main's ancestry, hasDiffAgainstMain keeps seeing
// "unmerged" and the relay would re-push -> re-PR -> re-merge every tick,
// minting an empty squash commit onto main each time (observed 2026-06-13). If a
// merged PR's head.sha equals the current tip, the content is already on main;
// the caller then deletes the local branch and stops. This is the loop guard
// that the local-branch delete in tryMerge alone cannot provide (it fails while
// the sandbox still has the branch checked out).
const isTipAlreadyMerged = async (branch, sha, token) => {
  const owner = CONFIG.repo.split("/")[0];
  const closed = await githubApi(
    "GET",
    `/repos/${CONFIG.repo}/pulls?state=closed&head=${owner}:${encodeURIComponent(branch)}&per_page=30`,
    null,
    token,
  );
  return closed.some((p) => p.merged_at !== null && p.head.sha === sha);
};

// GitHub rejects any push that creates/updates .github/workflows/** unless the
// App holds the `workflows` permission. We deliberately do NOT grant it, so the
// agent pipeline cannot modify its own CI gate (the merge backstop). Detect that
// specific rejection and surface it as a clean REFUSE instead of a generic
// crashing error — the change has to be landed by a human-credentialed push.
const WORKFLOW_PERM_REJECT = /refusing to allow .* workflow|without .?workflows.? permission/i;

const pushBranch = (branch, token) => {
  // First -c credential.helper= RESETS the helper list — otherwise a global
  // `gh` helper silently wins and pushes as the human user, not the App.
  // Token travels via env, never argv/disk. Exact refspec, no force.
  try {
    git(
      [
        "-c", "credential.helper=",
        "-c", `credential.helper=!f() { echo username=x-access-token; echo "password=$GIT_RELAY_TOKEN"; }; f`,
        "push", "origin", `refs/heads/${branch}:refs/heads/${branch}`,
      ],
      { GIT_RELAY_TOKEN: token },
    );
  } catch (e) {
    const out = [e.stderr, e.stdout, e.message].filter(Boolean).join("\n");
    if (WORKFLOW_PERM_REJECT.test(out)) {
      const err = new Error("workflow-file change needs a human push (App lacks `workflows` permission — by design)");
      err.code = "WORKFLOW_PERM";
      throw err;
    }
    throw e;
  }
};

const ensurePullRequest = async (branch, token) => {
  const owner = CONFIG.repo.split("/")[0];
  const open = await githubApi(
    "GET",
    `/repos/${CONFIG.repo}/pulls?state=open&head=${owner}:${encodeURIComponent(branch)}`,
    null,
    token,
  );
  if (open.length > 0) return { url: open[0].html_url, created: false };
  const subject = git(["log", "-1", "--format=%s", branch]);
  const commitList = git(["log", "--format=- %s", `origin/main..${branch}`]);
  const pr = await githubApi(
    "POST",
    `/repos/${CONFIG.repo}/pulls`,
    {
      title: subject,
      head: branch,
      base: "main",
      body: `${commitList}\n\n---\n🤖 <project>-relay: pushed from the sandbox working tree via the host relay.`,
    },
    token,
  );
  return { url: pr.html_url, created: true };
};

// Merge delegation (optional): squash-merge the branch's open PR when the
// HEAD commit message carries the "Relay-Merge: yes" trailer. CI-green is
// enforced SERVER-side by the main ruleset — an early attempt just gets 405
// ("Required status check ... is expected") and is retried on the next tick.
// A trailer on a non-HEAD commit is ignored: push more commits, re-signal.
const MERGE_TRAILER = /^Relay-Merge: yes$/m;

const tryMerge = async (branch, sha, token) => {
  if (!MERGE_TRAILER.test(git(["log", "-1", "--format=%B", branch]))) return;
  const owner = CONFIG.repo.split("/")[0];
  const open = await githubApi(
    "GET",
    `/repos/${CONFIG.repo}/pulls?state=open&head=${owner}:${encodeURIComponent(branch)}`,
    null,
    token,
  );
  if (open.length === 0 || open[0].head.sha !== sha) return; // PR missing, or remote behind local tip
  const number = open[0].number;
  try {
    // pass sha: GitHub rejects (409) if the tip moved between check and merge (TOCTOU guard)
    await githubApi(
      "PUT",
      `/repos/${CONFIG.repo}/pulls/${number}/merge`,
      { merge_method: "squash", sha },
      token,
    );
  } catch (e) {
    log(`merge pending #${number} ${branch}: ${e.message.slice(0, 160)}`);
    return;
  }
  log(`merged PR #${number} ${branch} (${sha.slice(0, 7)})`);
  // cleanup both sides so squash residue can't resurrect as an empty PR
  try {
    await githubApi("DELETE", `/repos/${CONFIG.repo}/git/refs/heads/${encodeURIComponent(branch)}`, null, token);
  } catch {} // already gone (delete_branch_on_merge) — fine
  try {
    git(["branch", "-D", branch]);
  } catch {
    log(`note: local ${branch} kept (checked out?) — delete manually`);
  }
};

const processBranch = async (name, sha, getToken) => {
  const remote = remoteSha(name);
  if (remote && remote !== sha && !isAncestor(remote, sha)) {
    log(`REFUSE ${name}: diverged from remote (force push required; resolve manually)`);
    return;
  }
  if (!hasDiffAgainstMain(name)) {
    return; // nothing to propose (fresh empty branch, or fast-forward-merged residue)
  }
  const token = await getToken();
  if (await isTipAlreadyMerged(name, sha, token)) {
    // Squash-merged residue. Do not re-push/PR/merge; clean up the local branch and stop.
    try {
      git(["branch", "-D", name]);
      log(`cleaned squash-merged ${name} (${sha.slice(0, 7)})`);
    } catch {
      log(`note: cannot delete local ${name} (checked out in sandbox); it clears once the sandbox switches branch`);
    }
    return;
  }
  if (remote !== sha) {
    try {
      pushBranch(name, token);
    } catch (e) {
      if (e.code === "WORKFLOW_PERM") {
        log(`REFUSE ${name}: ${e.message}`);
        return; // not an error — land workflow changes with a human push; the relay PRs it next tick
      }
      throw e;
    }
    log(`pushed ${name} (${sha.slice(0, 7)})`);
  }
  const pr = await ensurePullRequest(name, token);
  log(pr.created ? `PR created: ${pr.url}` : `PR exists: ${pr.url}`);
  await tryMerge(name, sha, token);
};

const main = async () => {
  git(["fetch", "--prune", "origin"]); // anonymous fetch is fine for a public repo
  const branches = localAgentBranches();
  if (branches.length === 0) {
    log(`idle: no ${CONFIG.branchPrefix}* branches`);
    return;
  }
  let cached = null;
  const getToken = async () => (cached ??= await mintInstallationToken());
  for (const { name, sha } of branches) {
    try {
      await processBranch(name, sha, getToken);
    } catch (e) {
      console.error(new Date().toISOString(), `error on ${name}:`, e.message);
      process.exitCode = 1;
    }
  }
};

main().catch((e) => {
  console.error(new Date().toISOString(), "relay fatal:", e.message);
  process.exit(1);
});
```

Private-repo note: `git fetch` would also need credentials — reuse the same
helper trick with a freshly minted token (the App needs `contents:read`, which
`contents:write` includes).
