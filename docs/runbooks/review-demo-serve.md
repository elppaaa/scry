# A review-only `gadak serve` an App Store reviewer can reach

The phone app shows nothing until it is paired with a `gadak serve`, and that
serve normally lives inside the owner's tailnet. An App Store reviewer is not
on that tailnet. Guideline 2.1 (App Completeness) asks that the reviewer can
exercise the app, and 2.1(a) that a demo account or mode exposes the app's
features — including the writes. This runbook produces the one thing that
satisfies both without changing the app: a **write-capable demo origin** on
the built-in tracker, published for the review window through Tailscale
Funnel, paired by a code pasted into the review notes.

It closes GDK-958. The decision it implements is the user's of 2026-08-27
("at store submission, turn on candidate 1 — a public demo serve") with one
change measured on 2026-09-14: the origin is not the read-only `gadak demo`
fixture but the same fixture **migrated onto the built-in tracker**, so the
reviewer's comment, transition and assignee edits actually land.

Facts this page arranges live elsewhere and win on conflict:
[`docs/runbooks/tailnet-serve.md`](tailnet-serve.md) (a resident serve),
[`docs/NETWORK.md`](../NETWORK.md) (what the serve exposes and to whom),
[`docs/runbooks/testflight-release.md`](testflight-release.md) (the upload),
[`SECURITY.md`](../../SECURITY.md).

## 0. What you need

- A host that runs `gadak serve` for the whole review window (a VPS on the
  tailnet is ideal — the project's own backlog host qualifies). `tailscale`
  up, `sudo` available for `tailscale serve`/`funnel`.
- Funnel enabled for the tailnet in the admin console (ACL `nodeAttrs`
  `funnel`). This is an account-owner step; `tailscale funnel status` says
  whether the node may use it.
- `gadak` at the release the app is built against (`gadak version`).
- The demo fixture on a machine that has it: `examples/demo.db` is mirrored by
  the `demo` workspace after `gadak --workspace demo demo` or any earlier
  session; `gadak workspaces` shows it with 534 issues.

## 1. Mint the review origin from the demo fixture

On the machine that holds the `demo` mirror:

```bash
gadak --workspace reviewdemo migrate --from demo --skip-attachments
gadak --workspace reviewdemo status
```

`migrate` creates a **new** workspace on the built-in tracker
(`origin_type: gadak`, `transport: local`) and copies issues, comments,
history, links and wiki pages into it; the report ends with a source-vs-
migrated table. Measured 2026-09-14: 534 issues, 614 comments, 71 pages,
20 page comments; `history` reads a higher number on the migrated side
because the migration's own writes are recorded — that row is expected to
differ. The `demo` workspace is untouched.

Prove the origin takes writes before publishing it:

```bash
K=$(gadak --workspace reviewdemo sql --no-header "select key from issues_full where status_category='new' order by key limit 1")
gadak --workspace reviewdemo comment "$K" -m "review-path probe: a write on the migrated demo origin"
gadak --workspace reviewdemo transition "$K"        # lists the reachable statuses
```

The comment lands and the transition list is non-empty; the app will do the
same through the pairing token. If the host is not the machine you migrated
on, copy the whole `~/.gadak/profiles/reviewdemo/` directory there — the
record is `origin/issuetap.db` inside it, not `gadak.db`.

## 2. Run it as a service, loopback only

```bash
gadak --workspace reviewdemo install-service -- --no-sync --no-open
loginctl enable-linger "$USER"
```

Loopback and default port 7777, exactly like the tailnet runbook's step 4.
`--no-sync` because the built-in origin needs no upstream. Do **not** pass
`--allow-remote`: the public leg is Tailscale's, and the mirror API stays
behind the host guard, which rejects any DNS-hostname request that carries
no pairing token (`docs/NETWORK.md`).

## 3. Publish for the review window

```bash
sudo tailscale serve --bg 7777
sudo tailscale funnel --bg 7777
tailscale funnel status
```

`funnel status` prints `https://<host>.<tailnet>.ts.net (Funnel on)`. The
phone's packaged HTTP capability allows `*.ts.net` and loopback only
(`mobile/src-tauri/capabilities/default.json`), so a Funnel URL is dialable
by the App Store binary without a capability change; a custom domain would
not be.

What is now reachable from the public internet, and by whom:

| Path | Without a token | With the review token |
| --- | --- | --- |
| `/healthz` | 200 | 200 |
| `/api/v1/issues/**` (read and write) | refused by the host guard | full mirror REST on the `reviewdemo` workspace only |
| `/api/v1/terminal/**` | refused | refused — mint no terminal scope |
| origin passthrough | refused | refused — mint no origin scope |

The data behind the token is the synthetic demo fixture. Nothing in
`reviewdemo` is real; a leaked token leaks fake issues and nothing else.

## 4. Mint the reviewer's pairing code

```bash
gadak --workspace reviewdemo pairing mint --label app-review \
  --scope serve --ttl 45d \
  --endpoint https://<host>.<tailnet>.ts.net --no-qr
```

One line on stdout is the offer. `--scope serve` and nothing else: no
`terminal`, no `origin`. `--ttl 45d` covers a review plus one resubmission;
extend rather than mint `--ttl 0`. Keep the label — `gadak --workspace
reviewdemo pairing revoke app-review` is the off switch in step 6.

## 5. Review notes (App Store Connect → App Review Information)

Paste, filling the two placeholders:

> gadak mobile is a companion to a self-hosted tracker the user runs
> themselves; it has no accounts. To review, open the app, copy the line below
> to the clipboard and tap **Paste & pair**:
>
> `<the offer line from step 4>`
>
> The app then shows a sample workspace (534 issues, 71 wiki pages) hosted
> for this review at `https://<host>.<tailnet>.ts.net`. Everything is live:
> open an issue, add a comment, change its status or assignee, edit its
> description, create an issue with the **+** button, open the wiki pages
> from the scope picker. **Explore the sample workspace** on the same first
> screen opens a bundled read-only copy of the same sample without any
> network, if the host is unreachable.

Say "companion to a self-hosted tracker", not "Jira client" — the review
origin is the built-in tracker, and the app never contacts Atlassian in this
configuration.

## 6. After the verdict

```bash
gadak --workspace reviewdemo pairing revoke app-review
sudo tailscale funnel --bg 7777 off
tailscale funnel status                    # must no longer say Funnel on
```

Leave `tailscale serve` and the service if the workspace is also the
recording fixture for the phone clips; otherwise `systemctl --user disable
--now` the unit. A resubmission re-runs steps 3–5 with a new label.

## What this does not settle

- **SECURITY.md** says "no gadak server". That stays true of the product;
  this is a serve the maintainer runs for the review window, published by
  Tailscale, holding synthetic data. Add one sentence to SECURITY.md's
  "The local server" section saying so when the first submission goes out,
  so the claim and the practice do not drift.
- Guideline 2.1(a) also asks for a demo *account* when the app has
  accounts. It has none — the pairing code is the credential. If Review
  asks for a login, answer with step 5's second paragraph.
- Whether the same host doubles as the phone-clip recording origin
  (GDK-1037) is a separate choice; nothing here prevents it.
