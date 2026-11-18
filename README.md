# LOL

LOL is a responsive, WhatsApp-inspired messaging app built with Flask, Flask-SocketIO, SQLAlchemy, and vanilla JavaScript. This testable first milestone covers account access and profiles, user search/direct chats, real-time one-to-one messages and status ticks, and the activity-sorted chat list.

## Project plan and schema

The ordered milestones and database design are documented in [docs/PLAN_AND_SCHEMA.md](docs/PLAN_AND_SCHEMA.md). Features 5–11 are intentionally deferred until this first slice has been tested: typing/presence, groups, Cloudinary media, message actions, emoji/reactions, web push, and settings/block/delete-account.

## Run locally

Python 3.11 or newer is recommended. From the project root in PowerShell:

```powershell
py -3 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
Copy-Item .env.example .env
```

Set a private `SECRET_KEY` in `.env`. For a quick local value, generate one with:

```powershell
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

Start the app and Socket.IO server:

```powershell
python run.py
```

Open `http://127.0.0.1:5000`. SQLite creates `instance/lol.sqlite` automatically. The application can be installed from a supporting browser using the PWA install control.

## Demo data

In a second terminal, run:

```powershell
python seed.py
```

Choose a password of at least 10 characters when prompted. The script creates three demo users and a sample one-to-one conversation. Accounts are `maya_chen`, `theo_park`, and `alex_rivera`; they also accept `maya@example.test`, `theo@example.test`, and `alex@example.test` for sign-in. Seed data is idempotent and only creates missing demo users/conversations. Do not use demo credentials for a public deployment.

## Tests

```powershell
python -m pytest -vv
```

Tests cover password hashing and account flows, profile editing, direct-chat creation/reuse, Socket.IO message submission and duplicate retry handling, and membership authorization for message reads and sends.

## Environment variables

| Variable | Purpose | Local default |
| --- | --- | --- |
| `SECRET_KEY` | Flask session and CSRF signing key. Set a long random value and never commit it. | Random per process if omitted |
| `DATABASE_URL` | SQLAlchemy connection string. SQLite is the development default; use Render PostgreSQL in production. | `sqlite:///lol.sqlite` |
| `SESSION_COOKIE_SECURE` | Set to `1` when served over HTTPS. | `0` |
| `MAIL_SERVER` | SMTP hostname for password reset delivery. | unset |
| `MAIL_PORT` | SMTP port. | `587` |
| `MAIL_USE_TLS` | Enable SMTP STARTTLS. | `1` |
| `MAIL_USERNAME` / `MAIL_PASSWORD` | SMTP credentials. | unset |
| `MAIL_DEFAULT_SENDER` | Verified sender address for reset email. | `LOL <noreply@example.com>` |
| `RATELIMIT_STORAGE_URI` | Flask-Limiter storage URI. Use Redis for shared production limits. | `memory://` |
| `DEMO_PASSWORD` | Optional seed password; when omitted, `seed.py` prompts securely. | unset |

Copy `.env.example` to `.env`; the app loads it on startup. Never commit `.env` or use development secrets in production.

## Render deployment

1. Push this project to a Git provider and create a Render **Web Service** from the repository.
2. Set the build command to `pip install -r requirements.txt`.
3. Set the start command to `gunicorn --worker-class gthread --workers 1 --threads 100 run:app`.
4. Add a Render PostgreSQL database and set `DATABASE_URL` to its **internal** connection string. The app translates Render's legacy `postgres://` URL form when necessary.
5. Add a high-entropy `SECRET_KEY`, set `SESSION_COOKIE_SECURE=1`, configure SMTP variables, and set `RATELIMIT_STORAGE_URI` to a Redis URL for shared rate-limit state.
6. Deploy. Schema tables are created automatically when the app starts. Use a persistent Render PostgreSQL database; the local SQLite file is not appropriate for ephemeral production disks.
7. After deployment, run `python seed.py` from a one-off shell only when demo data is specifically wanted. Do not seed public accounts for a real deployment.

This Socket.IO deployment uses one Gunicorn worker; multiple workers require a shared Socket.IO message queue (for example Redis) and coordinated rate-limit storage. For production database evolution, introduce Alembic migrations before changing deployed schemas; `create_all()` creates missing tables but does not migrate existing ones.

## Scope and security

- Account passwords use Werkzeug's salted password hashing. Reset tokens are random, stored only as SHA-256 hashes, single-use, and expire after 30 minutes.
- CSRF protection covers form and JSON POST routes; dynamic text is escaped by Jinja or the chat renderer.
- Login/register and password-reset requests are rate-limited; message sends are limited per authenticated user.
- HTTP and Socket.IO chat access require membership. Socket message IDs are unique to make reconnect retries safe.
- The browser keeps a bounded pending-message outbox in local storage and retries it after Socket.IO reconnects. Avoid shared/public devices if browser storage is not appropriate.
- Photo profile fields currently accept an HTTP(S) URL. Cloudinary uploads are deferred to the media milestone.
- WebSocket operation is same-origin. Configure HTTPS at the Render service and keep secrets only in environment variables.