# Student Clearance Document Request System

Cabiao Senior High School — Office of the Registrar.

This is a **working system**, not a prototype. A real HTTP server (`server.js`), a real SQLite database, and the web page in `public/` is wired to it. Requests, student records, staff accounts, uploads and notification logs survive a restart.

## Requirements

- **Node.js 22.13 or newer** (Node 24 LTS recommended; tested on 24.22). The database uses the built-in `node:sqlite` module, which needs the flag `--experimental-sqlite` on older releases and therefore requires 22.13+ to run as plain `node server.js`.
- Nothing else. There is **no `npm install`**: the server uses only Node's built-in modules (`node:http`, `node:sqlite`, `node:crypto`, `node:net`, `node:tls`).

Check your version:

```bash
node --version
```

## Run it

```bash
node server.js
```

Then open <http://127.0.0.1:3000>.

On first run the server creates `data/app.db` and one bootstrap Registrar account:

| Field | Value |
| --- | --- |
| Mobile | `0917 000 0002` |
| Email | `registrar@cshs.edu.ph` |

**Logging in:** open **Staff log in**. With no SMS gateway configured the server runs in demo mode, so every code is **123456** (it is also shown on screen and printed in the console). Gmail sign-in works the same way: choose the demo Registrar account, or type the email saved on a staff account.

## How the rules work (server-side)

Everything below is enforced in `server.js`, not in the browser:

- **Email must be verified** with a 6-digit code before a request can be submitted. Verification tokens are single-use and expire after 30 minutes.
- **Student records** are looked up by LRN or by name. A name search returns only a signed, 30-minute token and the last 4 LRN digits — the full LRN is never sent to the browser by a name search.
- **Tracking numbers** are generated on the server in the form `CSHS-XXXX-XXXX` (no ambiguous characters) and are unique.
- **Requests need the right evidence:** employment → local/abroad + government ID upload; university → university name + proof of request; military → proof of request; representative → authorization letter fields, photo of the person claiming, and consent.
- **Approval needs work:** the Registrar must first mark the documents checked. If a representative will claim the document, the authorization must also be marked correct. The server rejects an approval that skips either check.
- **Status flow:** `pending` → `approved` → ready for pick-up → `claimed`, or `pending` → `rejected` with a required reason.
- **Every status change emails the student** (and keeps a copy in the request's message log). Notifications are also written for Registrar / Administrative assistant / Principal accounts.
- **Sessions** are HttpOnly cookies backed by a `sessions` table (12 hours).
- **Role limits:** Registrar manages accounts and can do everything; Administrative assistant handles review and pick-ups; Principal can review only.

## Email and SMS

- **Email:** if `SMTP_HOST` is set, mail is sent through that SMTP server with a small built-in SMTP client (STARTTLS and AUTH LOGIN supported). If not set, every message is written to the `outbox` table and printed to the console, so the flow still works without a mail account.
- **SMS:** if `SMS_WEBHOOK_URL` is set, login codes are POSTed to it as `{ "phone": "...", "message": "..." }`. Otherwise they are printed to the console.
- **Demo mode** is on when no SMTP host is configured (`DEMO_MODE=1` forces it, `DEMO_MODE=0` turns it off). In demo mode, OTP and email codes are returned to the browser so the system can be tried on one laptop, and `GET /api/dev/outbox` lists recent mail.

## Configuration

Environment variables (all optional):

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address (`0.0.0.0` to allow other devices) |
| `DATA_DIR` | `./data` | Folder for the database and uploads |
| `DB_PATH` | `$DATA_DIR/app.db` | SQLite file |
| `UPLOAD_DIR` | `$DATA_DIR/uploads` | Uploaded files |
| `DEMO_MODE` | on when no SMTP | Return codes to the browser (always `123456`), expose the dev outbox |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` | — | Real mail delivery |
| `MAIL_FROM` | `no-reply@cshs.local` | Sender address |
| `SMS_WEBHOOK_URL` | — | SMS gateway for staff login codes |
| `REGISTRAR_NAME`, `REGISTRAR_PHONE`, `REGISTRAR_EMAIL` | Registrar / `09170000002` / `registrar@cshs.edu.ph` | Bootstrap account (first run only) |

Example with real Gmail SMTP:

```powershell
$env:SMTP_HOST="smtp.gmail.com"; $env:SMTP_PORT="587"
$env:SMTP_USER="your.address@gmail.com"; $env:SMTP_PASS="app-password"
$env:MAIL_FROM="your.address@gmail.com"
node server.js
```

> Use a Gmail **App Password**, not the normal account password.

## Test

One end-to-end test runs against the real HTTP server and a real SQLite database in a temporary folder:

```bash
node test.js
```

It covers: staff OTP login, adding/searching students, private-LRN search, email verification, required uploads, submission, tracking without an account, registrar file access, approval rules, representative authorization checks, hand-entered record flagging, role permissions, email outbox entries, release to claimed, and persistence across a server restart.

## API

Public:

```
GET  /api/health
GET  /api/me
POST /api/logout
POST /api/email/send-code
POST /api/email/verify
POST /api/auth/otp/send
POST /api/auth/otp/verify
POST /api/auth/google            (demo mode only)
GET  /api/students/search
GET  /api/students/lookup/:lrn
POST /api/requests               (multipart/form-data)
GET  /api/track/:tracking
```

Staff only:

```
GET  /api/requests
POST /api/requests/:id/decision
POST /api/requests/:id/id-verified
POST /api/requests/:id/authorization-check
POST /api/requests/:id/release
GET  /api/files/:id
GET  /api/notifications
POST /api/notifications/read
GET  /api/admin/users            (Registrar)
POST /api/admin/users            (Registrar)
PATCH /api/admin/users/:id       (Registrar)
POST /api/admin/students         (Registrar, Administrative assistant)
GET  /api/dev/outbox             (demo mode only)
```

## Files

```
server.js       HTTP server, routes, validation, auth, uploads, notifications
db.js           SQLite schema and queries (node:sqlite)
mail.js         SMTP client + outbox fallback
multipart.js    multipart/form-data parser for uploads
public/         the website
  index.html      every screen: request, track, registrar, pick-ups, accounts, about
  styles.css      school colours, fonts, the faint seal behind the page
  app.js          screen logic; talks to /api in server.js
  assets/         the school seal
test.js         end-to-end test (node test.js)
data/           created at runtime: app.db + uploads (not in git)
```

## Deploying

The server needs a machine that can run Node (a school PC, VPS, or a Node host such as Render/Railway/Fly.io). Plain **GitHub Pages cannot host this**, because Pages serves static files only and cannot run `server.js` or SQLite. If you deploy to a host:

1. Set `HOST=0.0.0.0` and the port your host provides.
2. Put the app behind HTTPS (the session cookie is marked `Secure` automatically when the request is HTTPS).
3. Set SMTP and SMS settings so real codes and updates are delivered.
4. Back up `data/` (the database and uploads).
