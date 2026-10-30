# Publishing checklist

This is how I cut a release, top to bottom. A release is a GitHub release
published by hand. `.github/workflows/release.yml` reacts to it. It stages the
npm package and publishes the multi-arch image, then publishes the MCP registry
entry once I've approved the npm version. Nothing publishes from `main`.

Versions here are written as `<version>` (for example `0.10.0`, or
`0.10.0-rc.1` for a release candidate) and tags as `v<version>`. Once the bump
has merged, read the version from `package.json` on `main` rather than typing
it:

```sh
git switch main && git pull --ff-only
VERSION=$(node -p "require('./package.json').version")
```

The commands below assume `VERSION` is set this way.

## Every release

### 1. Bump the version in a PR, then merge it

- [ ] `npm version <version> --no-git-tag-version` edits `package.json` and
      `package-lock.json` together. The CLI banner and the MCP handshake read
      the version from `package.json` at runtime.
- [ ] In `server.json`, set the same version in three places: the top-level
      `version`, the npm package entry's `version`, and the `v<version>` tag
      at the end of the image entry's `identifier`
      (`ghcr.io/dustinhansen/plex-mcp:v<version>`). The image entry has no
      `version` field of its own, because the registry rejects one.
- [ ] Turn `## Unreleased` in `CHANGELOG.md` into `## <version> — <date>`.
- [ ] `npm test`. It checks that the handshake, both `server.json` version
      fields and the image tag agree with `package.json`.
- [ ] `npm run smoke` against a server you are allowed to change.
- [ ] Open the PR, let CI go green, and merge it.

### 2. Cut the GitHub release

- [ ] Publish the release `v$VERSION` on `main`'s head. Pass `--prerelease`
      for a release candidate:

      ```sh
      gh release create "v$VERSION" --target main --title "v$VERSION" --notes "See CHANGELOG.md"
      ```

      The prerelease flag has to agree with the version: `release.yml` refuses
      a `-rc` version released as final, and a final version marked as a
      prerelease.

### 3. Watch `release.yml`

- [ ] Give GitHub a few seconds to queue the run, then watch it:

      ```sh
      gh run watch "$(gh run list --workflow release.yml --event release --limit 1 --json databaseId --jq '.[0].databaseId')"
      ```

      Check that the run it picks is for `v$VERSION`.

      Its jobs run in this order: `ci` (the pull request checks, against the
      tag), `verify` (the tag against every version field), then `npm` (which
      stages the version) and the two `image-build` legs side by side,
      `image`, and last `registry`, which waits for my approval in step 4.

      | release | npm dist-tag | image tags | registry entry |
      |---|---|---|---|
      | final | `latest` | `:v<version>`, and `:latest` moves to it | published |
      | prerelease | `next` | `:v<version>` only | not published |

### 4. Approve the npm version, then the registry job

- [ ] Once the `npm` job is green, approve the staged version. npm asks for
      2FA:

      ```sh
      npm stage list @dustinhansen/plex-mcp
      npm stage approve <stage-id>
      ```

      Or open the package's **Staged Packages** tab on npmjs.com and approve
      it there. Check the version and the dist-tag in the list before
      approving, because the tag can't be changed once the version is staged.
      `npm stage download <stage-id>` fetches the tarball to look inside it
      first.
- [ ] Final releases only: approve the `registry` job. In the run, choose
      **Review deployments**, check `registry` and choose **Approve and
      deploy**. Approve npm first. If I approve the job first, its first
      step waits about 8 minutes for the npm version, then fails and needs a
      re-run as in Recovery below.

      A prerelease skips the `registry` job, so the npm approval is its only
      step.

### 5. Verify what was published

- [ ] npm provenance, from an empty directory:

      ```sh
      cd "$(mktemp -d)" && npm init -y > /dev/null
      npm install "@dustinhansen/plex-mcp@$VERSION" && npm audit signatures
      ```

      It reports verified registry signatures and verified attestations. The
      package page on npmjs.com shows the provenance badge for the version.
- [ ] The image's build provenance:

      ```sh
      gh attestation verify "oci://ghcr.io/dustinhansen/plex-mcp:v$VERSION" --repo dustinhansen/plex-mcp
      ```
- [ ] The registry listing (final releases only):

      ```sh
      curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=io.github.dustinhansen/plex-mcp" | jq '.servers[].server.version'
      ```

      The list includes `$VERSION`.

### 6. Published-artifact smoke

Run once `release.yml` is green. It exercises the artifacts people actually
download, which catches a broken publish that the pre-publish checks in CI
cannot see.

- [ ] The npm package, downloaded from the registry and installed in a clean
      `node:22` container, the `engines` floor:

      ```sh
      git switch --detach "v$VERSION" && npm ci
      PKG=$(mktemp -d)
      npm pack "@dustinhansen/plex-mcp@$VERSION" --pack-destination "$PKG"
      docker run --rm -v "$PWD:/repo:ro" -v "$PKG:/pkg:ro" -w /repo node:22 \
        sh -c 'node test/build/emitted-artifact-smoke.ts package --tarball /pkg/*.tgz --node22 "$(command -v node)"'
      ```
- [ ] The image, pulled anonymously for each platform. `docker logout ghcr.io`
      first, so a stored credential cannot hide a private package. On a
      single machine the other architecture runs under emulation, which is fine
      for a boot check:

      ```sh
      docker logout ghcr.io
      for platform in linux/amd64 linux/arm64; do
        docker pull --platform "$platform" "ghcr.io/dustinhansen/plex-mcp:v$VERSION"
        node test/build/emitted-artifact-smoke.ts container \
          --image "ghcr.io/dustinhansen/plex-mcp:v$VERSION" --platform "$platform"
      done
      ```

### 7. Recovery

- **The `npm` job failed.** First check whether npm holds the version, staged
  or live:

  ```sh
  npm stage list @dustinhansen/plex-mcp
  npm view "@dustinhansen/plex-mcp@<version>" version
  ```

  If both show nothing (the list has no entry for the version, and `npm view`
  fails with `E404`), the job failed before npm held the version, so re-run
  the failed jobs:

  ```sh
  gh run rerun <run-id> --failed
  ```

  Then approve the staged version as in step 4. On a final release the re-run
  also starts the `registry` job, which the failure skipped, so GitHub asks for
  its approval too.

  A known transient cause is `TLOG_CREATE_ENTRY_ERROR` (409) from
  `npm stage publish`. The provenance write to the transparency log landed,
  its reply was lost, and npm's retry collided with its own entry, so npm
  never staged the version and a re-run stages it with provenance.

  If either command shows the version, npm holds it and a re-run would fail.
  When it is live, follow "A bad version reached npm" below. When it is only
  staged, check it as in step 4: the version, the dist-tag (`next` for a
  release candidate, `latest` for a final release) and, with
  `npm stage download`, the tarball. If any of them is wrong, follow "A staged
  version is wrong" below. If all of them are right, npm stored the version
  and the job failed after that, so approve it as in step 4.

  On a final release the failure also skipped the `registry` job, and
  "Re-run failed jobs" would start `npm` again, which fails on a version npm
  holds, so publish the registry entry by hand. Once the approved version is
  live, run this from a checkout with no local changes, since `publish` reads
  the checked-out `server.json`. It uses the `mcp-publisher` that
  `release.yml` pins, checked against the release's checksums:

  ```sh
  git switch --detach "v<version>"
  npm view "@dustinhansen/plex-mcp@<version>" version
  MCP=$(sed -n 's|.*registry/releases/download/\(v[0-9.]*\)/mcp-publisher.*|\1|p' .github/workflows/release.yml)
  OSARCH="$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')"
  BIN=$(mktemp -d)
  gh release download "$MCP" --repo modelcontextprotocol/registry --dir "$BIN" \
    --pattern "mcp-publisher_$OSARCH.tar.gz" --pattern "registry_${MCP#v}_checksums.txt"
  (cd "$BIN" && grep " mcp-publisher_$OSARCH.tar.gz\$" "registry_${MCP#v}_checksums.txt" \
    | shasum -a 256 -c && tar -xzf "mcp-publisher_$OSARCH.tar.gz" mcp-publisher)
  "$BIN/mcp-publisher" login github
  "$BIN/mcp-publisher" publish
  ```

  `login github` signs in with GitHub as `dustinhansen`, the account the
  registry lets publish under `io.github.dustinhansen`. The registry rejects
  `server.json` while the npm version isn't live or the image can't be pulled
  anonymously, which are the checks the `registry` job makes first. npm can
  take a few minutes to serve a newly approved version, so if `publish` fails
  on the npm lookup, wait and run it again. The release run stays red, since
  nothing re-ran `registry`. Check the listing as in step 5.
- **The `registry` job failed.** Re-run that job alone:

  ```sh
  JOB=$(gh run view <run-id> --json jobs --jq '.jobs[] | select(.name == "registry") | .databaseId')
  gh run rerun --job "$JOB"
  ```

  GitHub asks for the `registry` approval again. Never re-run the whole
  workflow: npm refuses a version it already holds, staged or live, so the
  `npm` job would fail again. The job's error names the cause. The usual ones
  are an npm version nobody approved yet, and an image GHCR still serves only
  to signed-in users, fixed on the package's settings page.
- **A staged version is wrong**, such as the wrong dist-tag or a broken
  build. Reject it before anyone approves it. npm asks for 2FA:

  ```sh
  npm stage reject <stage-id>
  ```

  Nothing was ever live, so no one installed it. Once the fix is on `main`,
  stage it as a new patch release through this checklist. Re-running the
  `npm` job would only stage the same build under the same tag again, since a
  re-run replays the original release event.
- **A bad version reached npm.** Deprecate it, never unpublish it:

  ```sh
  npm deprecate "@dustinhansen/plex-mcp@<bad-version>" "Broken: <why>. Use <fixed-version>."
  ```

  An unpublished version number can never be used again, the registry entry
  and any pinned install still point at it, and a deprecation warns everyone
  who installs it while leaving their lockfiles working. Then ship the fix as
  a new patch release through this checklist.

## Repository settings

These are the settings `dustinhansen/plex-mcp` runs with. Settings drift
silently, so each comes with the command that applies it, and a bare list
would leave re-checking to memory. I rejected a script because it would be
repo code for something that runs once. Where no API exists, I give the UI
path instead.

The `PATCH` and `PUT` calls can be repeated safely. The two ruleset `POST`
calls create a new ruleset each time, so list the existing ones first. To
re-check a setting, `GET` the same path: `gh api repos/dustinhansen/plex-mcp`
shows every field the `PATCH` calls set.

### Ruleset on `main`

Every CI check is required, and the branch must be up to date with `main`.
History is linear, and force-push and deletion are blocked. No approvals and no
signed commits are required. Repository admins may bypass the ruleset, but
only through a pull request, never with a direct push.

The required checks are the names `ci.yml` reports, which
`test/build/workflow-contract.test.ts` pins. `15368` is the GitHub Actions
app, so only a workflow run can satisfy a check.

```sh
gh api -X POST repos/dustinhansen/plex-mcp/rulesets --input - <<'EOF'
{
  "name": "main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "bypass_actors": [
    { "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "pull_request" }
  ],
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "required_linear_history" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false,
        "allowed_merge_methods": ["squash"]
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": true,
        "do_not_enforce_on_create": false,
        "required_status_checks": [
          { "context": "build", "integration_id": 15368 },
          { "context": "artifact-smoke (22)", "integration_id": 15368 },
          { "context": "artifact-smoke (24)", "integration_id": 15368 },
          { "context": "container-smoke (linux/amd64)", "integration_id": 15368 },
          { "context": "container-smoke (linux/arm64)", "integration_id": 15368 },
          { "context": "server-json", "integration_id": 15368 }
        ]
      }
    }
  ]
}
EOF
```

Check it with `gh api repos/dustinhansen/plex-mcp/rulesets`. To change an
existing ruleset, send the same body with `-X PUT` to
`repos/dustinhansen/plex-mcp/rulesets/<id>`.

### Merges

Squash only, with the PR title and body as the commit. Auto-merge is off,
merged branches are deleted, and "Always suggest updating pull request
branches" is on.

```sh
gh api -X PATCH repos/dustinhansen/plex-mcp \
  -F allow_squash_merge=true -F allow_merge_commit=false -F allow_rebase_merge=false \
  -f squash_merge_commit_title=PR_TITLE -f squash_merge_commit_message=PR_BODY \
  -F allow_auto_merge=false -F delete_branch_on_merge=true -F allow_update_branch=true
```

Squash-only keeps one commit per PR on `main`, each carrying its `(#N)` link
back to the PR. I rejected rebase merge because it drops that link, one wrong
click lands a branch's fixup commits on `main`, and the rebased commits lose
their signature verification.

### Releases and tags

Immutable releases on, and a ruleset that stops any `v*` tag from being moved
or deleted.

```sh
gh api -X PUT repos/dustinhansen/plex-mcp/immutable-releases

gh api -X POST repos/dustinhansen/plex-mcp/rulesets --input - <<'EOF'
{
  "name": "release tags",
  "target": "tag",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/tags/v*"], "exclude": [] } },
  "rules": [ { "type": "update" }, { "type": "deletion" } ]
}
EOF
```

npm provenance and the image attestation both name the commit a tag pointed
at when it was built. Immutable releases and the tag ruleset keep that true:
once `v<version>` is published, its tag and assets cannot be changed, so the
source a version claims is the source it was built from.

### Actions

The workflow `GITHUB_TOKEN` is read-only and cannot approve pull requests.
Every action must be pinned to a full-length commit SHA, and allowed actions
stay "all". A fork PR from a first-time contributor waits for approval before
it runs.

```sh
gh api -X PUT repos/dustinhansen/plex-mcp/actions/permissions \
  -F enabled=true -f allowed_actions=all -F sha_pinning_required=true
gh api -X PUT repos/dustinhansen/plex-mcp/actions/permissions/workflow \
  -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false
gh api -X PUT repos/dustinhansen/plex-mcp/actions/permissions/fork-pr-contributor-approval \
  -f approval_policy=first_time_contributors
```

SHA pinning is what makes "all" safe enough: an action can only run at the
exact commit a workflow names, which cannot change under it after the
workflow is reviewed. The workflow contract test enforces the pinning as well.

### Registry environment

The `registry` job runs in the `registry` environment. I'm its only required
reviewer, and only a `v*` tag's run can use it.

```sh
gh api -X PUT repos/dustinhansen/plex-mcp/environments/registry --input - <<'EOF'
{
  "prevent_self_review": false,
  "reviewers": [{ "type": "User", "id": 455498 }],
  "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true }
}
EOF
gh api -X POST repos/dustinhansen/plex-mcp/environments/registry/deployment-branch-policies \
  -f name='v*' -f type=tag
```

`455498` is `dustinhansen`'s user id (`gh api users/dustinhansen --jq .id`).
Self-review stays allowed because I publish every release and I'm the only
reviewer, so blocking self-review would leave the job with no one to approve
it. Both calls can be repeated safely: a second `POST` of the same rule
returns the one that exists. To re-check, `GET` the environment and
`repos/dustinhansen/plex-mcp/environments/registry/deployment-branch-policies`.

The environment holds no secrets. It's there for its reviewer: npm sends no
event when I approve a staged version, so the reviewer is how the `registry`
job knows to start. A run can wait up to 35 days for that approval. I don't
put the other jobs in an environment. The `npm` job's gate is npm's own
approval, and the image jobs have nothing to hold back for.

### npm package

The trusted publisher lets `release.yml` stage a version and nothing more.
It and the publishing-access setting are on the package's Settings page on
npmjs.com (npmjs.com/package/@dustinhansen/plex-mcp → **Settings**) under
**Trusted Publisher** and **Publishing access**, and both have an npm CLI
command. `npm trust` needs an npm login on an account with 2FA turned on.

**Trusted Publisher:** GitHub Actions, repository `dustinhansen/plex-mcp`,
workflow `release.yml`, no environment name. The only allowed action is
`npm stage publish`. "Allow `npm publish`" and "Allow `npm dist-tag`" are
unchecked.

```sh
npm trust github @dustinhansen/plex-mcp \
  --repo dustinhansen/plex-mcp --file release.yml --allow-stage-publish
npm trust list @dustinhansen/plex-mcp
```

`npm trust github` fails while the package already has a trusted publisher, so
run `npm trust list` first. `--allow-publish` is off unless you pass it. There
is no flag for "Allow `npm dist-tag`", so check on the Settings page that it is
unchecked.

"Allow `npm publish`" is the setting the staged release depends on. With it
checked, `release.yml` could publish a version directly and skip my approval in
step 4. npm doesn't let you edit a trusted publisher, and a package holds only
one, so changing any field means `npm trust revoke --id <id>` (the id is in
`npm trust list`) and creating it again. **When you recreate the trusted
publisher, make sure "Allow `npm publish`" is unchecked**, and read it back
afterwards.

The publisher names no environment because the `npm` job runs outside one.
Its gate is npm's own approval, as Registry environment above explains.

**Publishing access:** "Require two-factor authentication and disallow bypass
2fa tokens (recommended)".

```sh
npm access set mfa=publish @dustinhansen/plex-mcp
```

`mfa=publish` is that option: 2FA is required and no token can bypass it.
`mfa=automation` would let a bypass token publish without 2FA. Trusted
publishing goes through OIDC, not a token, so this setting doesn't block the
`npm` job.

### Security

Private vulnerability reporting is on, and so is secret scanning with push
protection. Dependabot alerts and security updates are on, and version updates
are off. CodeQL runs its default setup for `javascript-typescript` and
`actions`, and is not a required check.

```sh
gh api -X PUT repos/dustinhansen/plex-mcp/private-vulnerability-reporting
gh api -X PATCH repos/dustinhansen/plex-mcp --input - <<'EOF'
{
  "security_and_analysis": {
    "secret_scanning": { "status": "enabled" },
    "secret_scanning_push_protection": { "status": "enabled" }
  }
}
EOF
gh api -X PUT repos/dustinhansen/plex-mcp/vulnerability-alerts
gh api -X PUT repos/dustinhansen/plex-mcp/automated-security-fixes
gh api -X PATCH repos/dustinhansen/plex-mcp/code-scanning/default-setup \
  -f state=configured -f 'languages[]=javascript-typescript' -f 'languages[]=actions'
```

Dependabot version updates stay off by having no `.github/dependabot.yml`.
There is no setting for them. CodeQL stays out of the `main` ruleset so a
slow or flaky analysis cannot block a merge. Its alerts still show under
Security.

### Features

Issues on. Wiki, projects and discussions off.

```sh
gh repo edit dustinhansen/plex-mcp \
  --enable-issues --enable-wiki=false --enable-discussions=false
gh api -X PATCH repos/dustinhansen/plex-mcp -F has_projects=false
```

Projects go through the REST API because I've seen
`gh repo edit --enable-projects=false` report success and leave `has_projects`
true on this repository. Read the result back. It should show issues true and
the other three false:

```sh
gh api repos/dustinhansen/plex-mcp --jq '{has_issues,has_wiki,has_projects,has_discussions}'
```

The sidebar has no API. On the repository's home page, the gear beside
**About** → "Include in the home page": Releases and Packages checked,
Deployments unchecked.

### Labels

Both issue forms apply `needs-triage`, so the label has to exist. GitHub drops
a form's label that the repository doesn't have, and the issue comes in
unlabeled.

```sh
gh label create needs-triage --repo dustinhansen/plex-mcp --force \
  --color d4c5f9 --description "Nobody has looked at this yet"
gh label delete accessibility --repo dustinhansen/plex-mcp --yes
gh label delete bug --repo dustinhansen/plex-mcp --yes
gh label delete documentation --repo dustinhansen/plex-mcp --yes
gh label delete enhancement --repo dustinhansen/plex-mcp --yes
gh label delete "good first issue" --repo dustinhansen/plex-mcp --yes
gh label delete "help wanted" --repo dustinhansen/plex-mcp --yes
gh label delete invalid --repo dustinhansen/plex-mcp --yes
gh label delete question --repo dustinhansen/plex-mcp --yes
```

`--force` updates the label if it already exists, so the create is safe to
rerun. A delete of a label that is already gone prints `HTTP 404`, exits 1 and
changes nothing, so don't run the block under `set -e`. Afterwards
`gh label list --repo dustinhansen/plex-mcp` shows `needs-triage`, `duplicate`
and `wontfix`.

I chose `needs-triage` over GitHub's `bug` and `enhancement` because it says
whether anyone has looked at the issue yet, and the form already says what
kind of issue it is. Blank issues are off, so a documentation, question or
accessibility issue also comes in as a bug report or a feature request. I
deleted `documentation`, `question` and `accessibility` with `bug` and
`enhancement` to leave one label vocabulary. I deleted `invalid` because
`wontfix` already closes an issue I won't act on, and `help wanted` and
`good first issue` because they invite work I am not asking for. `duplicate`
and `wontfix` stay because they say how an issue closed, which no form can.

`test/build/issue-forms.test.ts` fails if a form names a label that this
section doesn't create and GitHub doesn't ship, and also if it names a default
that this section deletes.

### About

The description is copied from `package.json`'s `description`. Nothing keeps
them in sync, so if one changes, change both.

```sh
gh api -X PATCH repos/dustinhansen/plex-mcp \
  -f description="MCP server for Plex Media Server: full-library browsing with watched state, all-user watch history, recommendations, curation writes, plex.tv sign-in, and opt-in playback." \
  -f homepage=https://www.npmjs.com/package/@dustinhansen/plex-mcp
gh api -X PUT repos/dustinhansen/plex-mcp/topics \
  -f 'names[]=mcp' -f 'names[]=mcp-server' -f 'names[]=model-context-protocol' \
  -f 'names[]=plex' -f 'names[]=plex-media-server' -f 'names[]=claude' \
  -f 'names[]=ai' -f 'names[]=media-server'
```

Pinning has no API either: github.com/dustinhansen → "Customize your pins" →
check `plex-mcp`.
