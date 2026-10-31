<h1 align="center">unibox</h1>

<p align="center"><b>A calm Android launcher and a personal assistant that saves what you want to read, learn, research or do,<br>
finds the slot to do it, and keeps the infinite feeds from eating your day.</b></p>

<p align="center">
  <img alt="license MIT" src="https://img.shields.io/badge/license-MIT-3F6B4C">
  <img alt="Android 15" src="https://img.shields.io/badge/Android-launcher%20%2B%20blocker-3F6B4C">
  <img alt="self-hosted" src="https://img.shields.io/badge/self--hosted-your%20data%2C%20your%20server-3F6B4C">
</p>

<!-- media: docs/demo.mp4 and docs/screens/*.png -->

Unibox is two things that work together:

**1. A launcher that gets out of the way.** One screen: the time, the few apps you actually use at
this hour (learned from your own usage), and a line to tell the assistant something. Everything
else is one swipe or one search away.

**2. An assistant that does the remembering.** Throw anything at it (a link, a paper, a thought, a
voice note, a WhatsApp to yourself) and it files it, estimates the effort and suggests it when you
have a gap. It doesn't nag you with a to-do list; it proposes one next step.

## What it does

| | |
|---|---|
| **Quiet home screen** | Clock, a short list of apps for this time of day, one suggestion, and a search/ask box. No icons, no badges. |
| **Capture anything** | Links, text, photos, voice notes, WhatsApp self-chat. Enriched and classified (action, effort, context). |
| **Finds the slots** | Plans suggestions into the gaps of your calendar. Swipe to finish or drop; nothing is ever deleted. |
| **Doomscroll guard** | Detects minutes of steady scrolling in feeds, warns you at 3 minutes and closes the feed for a while if you keep going. |
| **App rules** | Feeds that stay closed, feeds that only limit scrolling, games with a daily budget, and essentials (banks, maps, calls, authenticators) that can never be blocked. |
| **Screen time** | Today's total against a limit you set, per-app breakdown and the last 7 days. Alerts at 75 %, at the limit and every extra hour. Computed on the phone. |
| **Sleep estimate** | From your last use at night to your alarm or first pickup. Nights are charted with 7 and 30 day averages. |
| **A guardian** | Uninstalling Unibox or switching off its protection asks for a code that someone else chose. |
| **Hold to uninstall** | Long-press an app in the drawer or in search results. |

## Principles

- **Self-hosted.** One small server (a €4 VPS is enough) holds your data. There is no Unibox cloud.
- **Open and nothing to configure on the phone.** The app is built with your server address baked in:
  open it and use it.
- **Private by construction.** Screen time and sleep are computed on the phone; only the sleep nights
  go to *your* server. The language model is yours to choose (see [Privacy](#privacy-and-data)).
- **Essentials are untouchable.** The blocker can't lock you out of payments, maps, calls or 2FA.

## Quick start

```sh
git clone <this repo> && cd unibox
npm install
cp .env.example .env        # set UNIBOX_TOKEN, optionally UNIBOX_ME_NAME
export NAN_API_KEY=...      # or point NAN_BASE_URL at any OpenAI-compatible endpoint
npm run serve               # http://127.0.0.1:8124
```

Then build the Android app (`android/`, see [Android](#android)) and deploy the server with
`docker compose` for automatic HTTPS ([Deploy](#deploy)).

## Architecture

```
mailos.db ────────┐
WhatsApp (Baileys)┼──> unibox.db ──> LLM digest (nan / qwen3.6) ──> digests/YYYY-MM-DD.md
LinkedIn CSVs ────┘

dumps (web · CLI · self-chat · notes) ──> items
  ──> enrich (OG link meta · vision · audio) ──> classify (action/effort/context)
  ──> prioritize + batch ──> nudge (notify-send + self-chat when you're free)
```

- **Email** — read-only attach to mailos's SQLite DB; reuses its
  `needs-reply` / `waiting-on-them` classification. No duplicate Gmail sync.
- **WhatsApp** — self-contained Baileys session (linked-device protocol),
  stores every incoming text into SQLite. The **Message yourself** thread is
  treated as a capture inbox: its text and media become items, and nudges can
  be sent back into it. Later: swap to an OpenClaw session for two-way replies.
- **Dump** — anything can be thrown at `items`: a link (OG/oEmbed enriched,
  YouTube/Vimeo/Spotify recognised), a photo (vision description), a voice
  note (transcription), a video (ffmpeg poster), or plain text. Sources: the
  web composer, `unibox dump`, a WhatsApp chat export in `inbound/whatsapp/`,
  and `.txt`/`.md` drops in `inbound/notes/`. Content hashes dedupe.
- **Classify + prioritize** — the LLM tags each item with action
  (`read/watch/listen/do/buy/reply/reference`), effort in minutes, context
  (`quick/focus/phone/commute/desk/errand`), urgency and importance; priority
  rewards urgency and importance, discounts effort, and floats old items up.
  Items sharing a context/effort bucket form a **"one go"** batch.
- **Nudges** — when you're *Available* (toggle in the Dump tab) and outside
  quiet hours, the worker sends at most one nudge per hour: the best batch as a
  `notify-send` toast, and a message into *Message yourself* if enabled.
  Items nudged are cooled down for 3 h.
- **LinkedIn** — GDPR export CSVs dropped into `inbound/linkedin/`
  (Settings → Data privacy → Get a copy of your data → Messages). Hash-deduped.
- **Todo layer** — WhatsApp/LinkedIn chats are triaged into mailos's same
  taxonomy (`needs-reply` / `waiting-on-them` / `no-action`) so all three
  sources share one todo model. Rules first (last message is mine →
  `waiting-on-them`, automated senders → `no-action`), LLM JSON triage
  (temp 0) for the ambiguous ones, fail-safe to `needs-reply`. Aging floats
  old requests up.
- **Worker** — while `watch` or `serve` runs: classifies new chats every
  15 min (batched, time-budgeted) and fires the morning digest with a desktop
  `notify-send` (`DIGEST_HOUR`, default 8) — same job model as mailos's
  scheduler.

## Setup

1. `npm install`
2. `cp .env.example .env`. `NAN_API_KEY` comes from your environment —
   `export NAN_API_KEY=…` in `~/.bashrc` is enough, even for the systemd service;
   `npm run check` confirms the model (`qwen3.6` by default) answers.
   `MAILOS_DB` should point at your mailos DB.
3. WhatsApp pairing: `npm run link`, scan the QR from
   WhatsApp → Linked devices. Session persists in `session/`.
4. LinkedIn: drop `messages.csv` from your GDPR export into
   `inbound/linkedin/` and run `npm run ingest`.
5. Seed the Dump inbox: export your WhatsApp *Message yourself* chat (chat →
   More → Export chat, with media) into `inbound/whatsapp/`, and drop any
   `.txt`/`.md` lists into `inbound/notes/`; run `npm run import-wa` /
   `npm run import-notes`. Or just paste into the Dump composer.

## Usage

```sh
npm run link          # pair WhatsApp (once)
npm run watch         # stay connected: capture + classify + process + nudges
npm run serve         # web UI on http://127.0.0.1:8124 + background worker
npm run dump "https://example.com/article"   # or: npm run dump -- --file notes.md
npm run items         # list the classified inbox
npm run import-wa     # import inbound/whatsapp/ chat exports
npm run import-notes  # import inbound/notes/ .txt/.md drops
npm run process       # enrich + classify any unprocessed dumps
npm run nudge         # send the next nudge now (--force ignores focus/quiet)
npm run available     # show or set availability (available on|off)
npm run classify      # one-shot todo triage of WhatsApp/LinkedIn chats
npm run digest        # generate today's digest, prints it and saves to digests/
npm run ingest        # import any new LinkedIn export CSVs
```

## Deploy

```sh
deploy/deploy.sh    # installs + enables the systemd user service
```

Runs as `unibox.service` (auto-start at login, restart on crash): web UI +
worker + WhatsApp socket in one daemon. Logs: `journalctl --user -u unibox`.

### Cloud (Docker + automatic HTTPS)

Run the whole thing on any small server (Lightsail, Hetzner, Fly.io, a €4 VPS).
Caddy terminates HTTPS and fetches a certificate automatically:

```sh
cp .env.example .env        # set NAN_API_KEY, UNIBOX_DOMAIN, UNIBOX_TOKEN
# point the domain (or an sslip.io name like 203-0-113-7.sslip.io) at the box
docker compose up -d --build
```

Then open `https://<domain>/?token=<token>` and pair WhatsApp from the
**Sessions** tab — the QR renders right in the page. `data/` and the WhatsApp
session live in named volumes, so restarts keep your link and history.

Because it's real HTTPS, **Web Push works here**: enable phone alerts and
nudges arrive on the phone without going through WhatsApp. Point the Android
app at this address with `npm run app-server -- https://<domain> <token>`.

## Google (sign-in + Gmail + Calendar)

One Google grant signs you into the web UI and gives read-only access to
Gmail and your primary Calendar. Gmail threads join the todo layer as source
`email` (replacing mailos), today's events show in Planned, and the digest
sees today and tomorrow's calendar.

1. [Google Cloud Console](https://console.cloud.google.com/) → new project →
   **APIs & Services → Library**: enable **Gmail API** and **Google Calendar API**.
2. **OAuth consent screen** (Google Auth Platform): External, add your address
   as a test user, add the scopes `gmail.readonly` and `calendar.readonly`.
   Then **Publish app** (it stays unverified, which is fine for one user): in
   *Testing* mode Google expires refresh tokens after 7 days.
3. **Credentials → Create OAuth client ID → Web application**. Authorized
   redirect URIs: `http://localhost:8124/auth/google/callback` (plus
   `https://<domain>/auth/google/callback` for the cloud deploy).
4. Put the client ID/secret in `.env` (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
   `GOOGLE_ALLOWED_EMAIL`), restart, open `http://localhost:8124` →
   **Sign in with Google**. Use `localhost`, not `127.0.0.1`: the redirect
   must match exactly.

`npm run check` verifies the nan model and the Google link. Once Google is
configured the UI requires sign-in (`UNIBOX_GOOGLE_LOGIN=0` turns that off);
`UNIBOX_TOKEN` keeps working alongside it, which is what the Android app uses,
because Google refuses OAuth inside embedded WebViews.

## Web UI

`npm run serve` opens the Nocturne-styled interface (design comp:
`Unibox.dc.html`, design system in `web/styles.css`):

- **Brief** — the 20-second read: headline, live stats, arrivals histogram
  (accent foot = what survived triage), and lane cards (needs your reply /
  on the clock / opportunities / worth exploring).
- **Triage** — one card per task with the triage reasoning, raw signals in
  the drawer, search + filters, and a Planned panel: schedule, dismiss
  (undoable), or drag a card onto the panel to place it yourself.
- **Dump** — the big canvas: write/paste anything (one line → one item),
  attach photos/videos/files, record a voice note. Below it, the classified
  archive with action filters and search, a **One go** strip grouping things
  that fit the same moment, and each item's Done / Snooze / Drop. The
  availability card toggles Focus↔Available and can nudge on demand.
- **Sessions** — start/stop social sessions without touching a terminal:
  WhatsApp pairing renders a live QR in a dialog (scan from
  WhatsApp → Linked devices); LinkedIn takes the GDPR export via
  *Request export ↗* and an in-page CSV upload; each connector shows its
  live state and message count.

Interactions persist to SQLite (dismissed items, planned blocks, item state,
availability); the page polls every 30 s and the worker keeps classifying,
processing and nudging in the background.

Typical day: leave `npm run serve` (or the systemd service) running, dump
things as they come, and let the nudges pick the moment.

## Phone UI

At phone width (and in the Android app) unibox shows its own interface
(`web/mobile.js`, `web/mobile.css`; Geist fonts in `web/fonts/`). It is in Spanish, and so is the
text the model writes (`UNIBOX_LANG=es`, the default; `en` switches back).

- **Home** — time, a few apps for this hour, the one suggestion (*Descartar* drops it), the
  screen-time line and last night's sleep. Swipe up for all apps.
- **Guardado** — everything you saved, as swipe rows (*Hecho* / *Quitar*), with links to goals and
  journal, sleep, screen time, connections and the removed items.
- **Pantalla** and **Sueño** — your stats, drawn from the phone's own usage records.
- Tasks can be paused entirely (*Pausar tareas*): nothing is suggested, planned or nudged, and
  nothing is deleted.

The classic desktop screens (Triage, Dump, Sessions) are still available from *Conexiones*.

## Android

unibox is an installable PWA — no Play Store, no APK needed to start:

1. Start it reachable from the phone:
   ```sh
   UNIBOX_HOST=0.0.0.0 UNIBOX_TOKEN=pick-a-long-secret npm run serve
   ```
   `UNIBOX_HOST` defaults to `127.0.0.1`; binding `0.0.0.0` exposes it on your
   network, so set `UNIBOX_TOKEN` too. Open
   `http://<machine-ip>:8124/?token=<secret>` **once** on the phone — it sets a
   cookie, so you don't paste the token again.
2. Chrome → menu → **Install app** (or *Add to Home screen*). It opens
   full-screen with its own icon.
3. **Share to unibox** — from Chrome, Photos, WhatsApp, anywhere: *Share* →
   **unibox**. Links go to `/api/capture`; photos/videos/voice notes go to
   `/api/capture/file`. They land as items and get classified. The "Dump" tab
   and the CLI do the same.
4. **Notifications on the phone** — two channels:
   - *WhatsApp* — nudges are sent to your *Message yourself* chat (works
     already, needs no https).
   - *Web Push* — tap **Phone alerts** in the Dump tab. This needs a secure
     context (`https://`), because browsers block Web Push on plain http.
     Easiest upgrade is Tailscale:
     ```sh
     tailscale serve https / http://127.0.0.1:8124
     ```
     then open the `https://<machine>.<tailnet>.ts.net` URL on the phone and
     enable alerts. Works anywhere, nothing exposed publicly.

### Native Android app (APK)

There is also a Capacitor shell that wraps the same UI and registers as an
Android **share target** (links, images, video, audio, PDFs):

```sh
npm install
npx cap sync android                    # copies android-web/ + config into android/
cd android && ./gradlew assembleDebug    # needs JDK 21 + Android SDK 35
# → android/app/build/outputs/apk/debug/app-debug.apk
```

Install it with `adb install -r android/app/build/outputs/apk/debug/app-debug.apk`,
or copy the APK to the phone. On first launch it asks for your server URL
(`http://<machine-ip>:8124` or your Tailscale address) and an optional token;
after that, sharing from any app posts straight into the Dump inbox. Cleartext
HTTP is enabled for LAN use; prefer the https Tailscale URL when you can.

To remove even that one-time step, bake your server into the app:

```sh
npm run app-server -- https://unibox.example.com <token>
npx cap sync android && (cd android && ./gradlew assembleDebug)
```

The app then opens straight into unibox (and probes the server, only showing
the connect screen if it can't be reached).

The launcher/splash/icons are generated by `npm run icons`; set
`JAVA_HOME`/`ANDROID_HOME` if Gradle can't find them. This is a debug APK —
release signing is a separate step.

## Roadmap

- [ ] Telegram push for the morning brief (Bot API is the zero-risk channel)
- [ ] OpenClaw adapter: reply from the digest surface without opening apps
- [ ] WhatsApp chat-name resolution (currently raw JIDs)
- [ ] Deadline extraction into lanes (a date in the body beats a label)
- [ ] True "not busy" detection: desktop idle / calendar instead of the manual toggle
- [ ] Snooze/done commands typed straight into the *Message yourself* chat
- [ ] Verify nan vision/audio endpoints; fall back to local yt-dlp/whisper/ffmpeg


## Privacy and data

- **Nothing personal is in this repository.** Your database, WhatsApp exports, Google sign-in, API key,
  server address and token live in `.env`, `data/`, `inbound/` and the server itself, all git-ignored.
  The Android app gets its server address and token baked in at build time (`android-web/config.js`, also ignored).
- **The language model** is called through the nan API (`NAN_BASE_URL`, default `https://api.nan.builders/v1`).
  Your messages, mail and tasks are sent to it as prompts. nan's site states "Zero logs. No prompt or
  response logging", processing in the EU and no training on your data; that is their claim, check it
  yourself before sending anything sensitive, or point `NAN_BASE_URL` at a model you run.
- **On the phone only:** screen time and the sleep estimate are computed from Android's usage records;
  the sleep nights are the only part sent to your own server.
- Deploying it means running your own server and keeping its token secret. Anyone with the token has your data.
