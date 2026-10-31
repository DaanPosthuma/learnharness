# Mobile web app, offline commutes, and family accounts

This fork turns LearnHarness into a hosted web app you install on a phone,
keep reading on the underground, and share with family members who each get
their own sessions, knowledge graph, settings and API keys.

Three layers, each independent of the others:

| Layer | Where | What it does |
|---|---|---|
| PWA + offline | `public/manifest.webmanifest`, `public/sw.js`, `components/pwa.tsx`, `components/offline-library.tsx`, `app/offline/page.tsx` | Installable from the browser; the service worker keeps the app shell, the knowledge graph, and recent sessions readable with no signal; the offline banner |
| Offline outbox | `components/session-core.ts` (OFFLINE OUTBOX) | A message or answer sent with no connection waits for `online`, survives a reload, and posts itself when the signal returns |
| Accounts gateway | `gateway/` | Sign-in with username + password; one LearnHarness process per user, each on its own data directory; nothing in the app itself is multi-tenant |
| Mobile layout | `components/sidebar.tsx`, `app/globals.css` (MOBILE) | Below 768px the sidebar is a drawer; safe-area insets; no iOS input zoom |

## What works offline, honestly

The teacher is an LLM behind the network. **A lesson cannot advance without
a connection.** What the phone can do in a tunnel:

- open the app (home screen icon, no browser chrome) and the knowledge graph as last seen;
- read every session saved on the device — the warmer saves the 25 most recent each time the app is opened online, and `/offline` lists them with a "save now" button;
- type the next message or answer the pending quiz: the card appears immediately with a quiet "Waiting for a connection — sends automatically" line, a copy is kept in the browser, and it posts itself when the train surfaces (even if the page was reloaded or the phone slept);
- what it cannot do: start a *new* session, or receive the teacher's reply, until online.

The service worker is only registered in production builds (`npm run build`
+ `npm start`), or in dev with `NEXT_PUBLIC_LH_PWA=1`, because its caching
fights hot reload.

## Accounts: how the gateway works

LearnHarness is deliberately single-learner: one process, one `LH_DATA_DIR`,
one `auth.json` of API keys, one graph. Threading a user id through the job
runner, the extraction pipeline, the subscription bridges and the event bus
would be a large, risky change with no upstream appetite for it. The gateway
sidesteps all of it:

```
phone ── https ── Caddy ── gateway :8080 ──┬── next start :4100  (LH_DATA_DIR=…/users/dean)
                      (login, cookie,      ├── next start :4101  (LH_DATA_DIR=…/users/anna)
                       one proxy per user) └── …started on first request, stopped after 60 idle min
```

- `gateway/server.mjs` — the public port. `/login`, `/logout`, `/account`
  (change password), `/gateway/health`. Everything else requires the signed
  `lh_session` cookie (HMAC, 30 days, invalidated by a password change) and
  is proxied to the user's own process, which it starts on demand.
- `gateway/cli.mjs` — `add`, `passwd`, `remove`, `list`. Without `--password`
  it prints a temporary password and the person is made to choose their own
  at first sign-in.
- Data root (`LH_HOME`, default `/var/lib/learnharness`): `users.json`
  (scrypt hashes), `gateway-secret`, `users/<name>/data`, `users/<name>/auth.json`.
- Served to anyone, straight from `public/`: the web manifest (browsers fetch
  it without cookies), the worker script and the icons — the install prompt
  needs them before sign-in. Every other path needs the cookie; an API call
  without one gets `401` with `x-lh-gateway: unauthorized`, which is the only
  401 the service worker treats as "sign in again" (the app's own routes also
  answer 401, e.g. dictation without a Deepgram key).
- Each user adds their **own provider keys** in Settings, exactly as on the
  desktop app. Keys are never shared between accounts.

The gateway is zero-dependency Node and has tests (`tests/gateway-lib.test.ts`).

## Run it locally

```bash
npm run build
LH_HOME=/tmp/lh-home node gateway/cli.mjs add me --password 'choose-something'
LH_HOME=/tmp/lh-home node gateway/server.mjs        # http://localhost:8080
```

## Deploy: Docker + Caddy (any box with a public hostname)

```bash
LH_DOMAIN=learn.example.com docker compose up -d --build
docker compose exec app node gateway/cli.mjs add dean
```

Caddy fetches a Let's Encrypt certificate for `LH_DOMAIN` and streams SSE
unbuffered. Data lives in the `lh-data` volume. Without a domain of your own,
`<ip-with-dashes>.sslip.io` resolves to the IP and gets a certificate too.

## Deploy: one small EC2 instance (what `deploy/aws-launch.sh` does)

```bash
export AWS_PROFILE=… AWS_REGION=eu-west-2
docker build --platform linux/amd64 -t learnharness-web:local .
deploy/aws-launch.sh all            # infra → push → launch → wait
deploy/aws-launch.sh adduser dean   # prints a temporary password
deploy/aws-launch.sh status
```

What it creates (all idempotent, all named `learnharness*`):

- ECR repository `learnharness-web` (keeps the last 5 images);
- IAM role + instance profile `learnharness-ec2` with SSM and ECR read-only — no SSH key, no port 22; remote commands go through SSM (`deploy/aws-launch.sh run '…'`);
- security group with 80 and 443 open (the gateway's login is the access control);
- an Elastic IP, so the hostname never changes;
- a `t3a.small` (2 vCPU, 2 GB, 16 GB gp3) on Amazon Linux 2023 with a 2 GB swap file, Docker, and the compose stack in `/opt/learnharness`. First boot pulls the image (retrying until the push has landed) and prints `LEARNHARNESS_READY` into `/var/log/learnharness-setup.log`.

Rough monthly cost in eu-west-2: about $14 for the instance, $1.30 for the
volume, $3.60 for the public IPv4 address, a few cents for ECR.

Updating: build and push a new image, then `deploy/aws-launch.sh update`
(runs `/usr/local/bin/lh-update` on the box: ECR login, pull, `compose up -d`).

Sizing: the gateway idles at ~50 MB; each active user's Next.js process
takes 250–400 MB and is stopped after `LH_IDLE_MINUTES` without requests. A
2 GB box with swap comfortably runs two or three people learning at once.

## Installing on a phone

- **iPhone:** open the site in Safari → Share → *Add to Home Screen*. iOS
  only installs PWAs from Safari.
- **Android:** Chrome shows an *Install app* prompt, or ⋮ → *Add to Home screen*.

Open the app once while online so the warmer saves your recent sessions;
check `/offline` ("Saved on this device") before going underground.
