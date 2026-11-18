# LOL Project Plan and Database Schema

## Delivery plan

### Milestone 1: testable first release
1. Accounts: register, sign in/out, email-based password reset, and editable profile fields.
2. Contacts: find registered users by username, email, or phone and start/reuse a direct chat.
3. Direct messaging: Socket.IO messages, timestamps, and sent/delivered/read state.
4. Chat list: latest-activity ordering, preview, timestamp, unread count, and client-side search.

This milestone also includes responsive mobile navigation, light/dark theme, PWA install metadata, seeded demo data, setup/deployment documentation, and focused tests.

### Later milestones (intentionally deferred)
5. Typing and presence; 6. group chats; 7. Cloudinary media; 8. reply/delete/copy/forward; 9. emoji/reactions; 10. web push; 11. settings, blocking, and account deletion.

## Schema

- `users`: id, username, email, phone, password hash, display name, avatar URL, about text, created/updated timestamps. Username and provided email/phone are unique.
- `contacts`: owner and contact user IDs plus creation time. Unique `(owner_id, contact_id)`; contacts are optional saved relationships and are not required to message a searchable user.
- `chats`: id, type (`direct` or `group`), optional name/avatar, creator, created/updated timestamps. Milestone 1 creates only direct chats.
- `chat_members`: chat/user IDs, role, joined timestamp, last-read message ID/time. Unique `(chat_id, user_id)`; supports membership authorization and unread counts.
- `messages`: id, chat/sender IDs, body, optional media URL, optional reply target, created timestamp, and soft-delete metadata. `(chat_id, created_at)` index supports recent-message paging.
- `message_status`: message/user IDs, delivered/read timestamps. Unique `(message_id, user_id)`; supports per-recipient delivery/read ticks.

Core constraints and indexes: unique normalized usernames/emails/phones where present; foreign keys with cascading membership/message cleanup; indexes on `messages(chat_id, created_at)`, `chats(updated_at)`, `chat_members(user_id, chat_id)`, and `message_status(message_id, user_id)`.

The initial schema also creates `reactions` (message/user/emoji), `blocks` (blocker/blocked user), and `push_subscriptions` (user, endpoint, and browser keys) for the later feature milestones. Their workflows remain deferred. Password reset tokens are stored hashed with expiry in a reset-token table. Passwords and reset tokens are never stored in plaintext.

## Security and behavior notes

- Passwords use Werkzeug's password hashing; sessions use an environment-provided secret and secure cookie options in production.
- Forms use CSRF tokens, inputs are validated server-side, and templates escape dynamic text.
- Login and message endpoints are rate-limited; Socket.IO events verify authenticated session and chat membership.
- SQLite is the local default. Set `DATABASE_URL` to PostgreSQL for deployment; SQLite URLs are normalized for SQLAlchemy.
- Socket.IO delivery is at-least-once from the browser's pending outbox, with stable client message IDs for duplicate suppression.
