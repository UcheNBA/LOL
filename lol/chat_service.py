import secrets
from collections import defaultdict
from datetime import timezone

from sqlalchemy import delete as sql_delete, func, or_, select
from sqlalchemy.orm import selectinload

from .extensions import db
from .models import (Chat, ChatMember, Message, MessageHidden, MessageStar,
                     MessageStatus, Reaction, User, utcnow)
from .presence import is_online

DELETED_PREVIEW = "This message was deleted"


def as_utc(value):
    """SQLite hands back naive datetimes; treat them as UTC like we stored them."""
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def iso(value):
    return as_utc(value).isoformat() if value else None


def format_time(value):
    return as_utc(value).astimezone().strftime("%I:%M %p").lstrip("0")


def fmt_duration(seconds):
    seconds = int(seconds or 0)
    return f"{seconds // 60}:{seconds % 60:02d}"


def alive_clause():
    """SQL condition: the message has not disappeared yet."""
    return or_(Message.expires_at.is_(None), Message.expires_at > utcnow())


def member_for(chat_id, user_id):
    return db.session.scalar(select(ChatMember).where(ChatMember.chat_id == chat_id, ChatMember.user_id == user_id))


def chat_title(chat, user_id):
    if chat.type == "group":
        return chat.name or "Group chat"
    other = next(
        (member.user for member in chat.members if member.user_id != user_id), None)
    return other.display_name if other else "Conversation"


def avatar_initial(name):
    return (name or "?").strip()[:1].upper()


def hidden_ids_for(user_id):
    """Subquery of message ids this user chose to 'delete for me'."""
    return select(MessageHidden.message_id).where(MessageHidden.user_id == user_id)


def aggregate_status(message):
    recipients = [
        status for status in message.statuses if status.user_id != message.sender_id]
    if recipients and all(status.read_at for status in recipients):
        return "read"
    if recipients and all(status.delivered_at for status in recipients):
        return "delivered"
    return "sent"


def preview_core(message):
    """One line that describes a message: used in chat list, replies, stars."""
    if message.deleted_at:
        return DELETED_PREVIEW
    if message.kind == "image":
        return message.body or "Photo"
    if message.kind == "video":
        return message.body or "Video"
    if message.kind == "voice":
        extra = f" ({fmt_duration(message.media_duration)})" if message.media_duration else ""
        return "Voice message" + extra
    if message.kind == "file":
        return message.media_name or "File"
    return message.body or ""


def media_payload(message):
    if message.kind not in ("image", "voice", "video", "file") or not message.media_url:
        return None
    return {
        "url": f"/api/messages/{message.id}/media",
        "name": message.media_name or "file",
        "size": message.media_size or 0,
        "duration": message.media_duration or 0,
    }


def messages_payload(messages, viewer_id):
    """Serialize many messages with a handful of queries instead of ~5 each."""
    if not messages:
        return []
    ids = [message.id for message in messages]

    chips = defaultdict(list)
    for message_id, emoji, count in db.session.execute(
        select(Reaction.message_id, Reaction.emoji, func.count(Reaction.id))
        .where(Reaction.message_id.in_(ids))
        .group_by(Reaction.message_id, Reaction.emoji)
        .order_by(func.min(Reaction.id))
    ).all():
        chips[message_id].append((emoji, count))

    mine = defaultdict(set)
    for message_id, emoji in db.session.execute(
        select(Reaction.message_id, Reaction.emoji).where(
            Reaction.message_id.in_(ids), Reaction.user_id == viewer_id)
    ).all():
        mine[message_id].add(emoji)

    starred = set(db.session.scalars(
        select(MessageStar.message_id).where(
            MessageStar.user_id == viewer_id, MessageStar.message_id.in_(ids))
    ).all())

    reply_ids = {m.reply_to_id for m in messages if m.reply_to_id}
    parents = {}
    if reply_ids:
        parents = {
            parent.id: parent for parent in db.session.scalars(
                select(Message).where(Message.id.in_(reply_ids))
                .options(selectinload(Message.sender))
            ).all()
        }

    def reply_summary(message):
        parent = parents.get(message.reply_to_id) if message.reply_to_id else None
        if not parent:
            return None
        deleted = parent.deleted_at is not None
        return {
            "id": parent.id,
            "sender_id": parent.sender_id,
            "sender_name": parent.sender.display_name if parent.sender else "Former member",
            "body": "" if deleted else preview_core(parent)[:200],
            "deleted": deleted,
        }

    payloads = []
    for message in messages:
        deleted = message.deleted_at is not None
        payloads.append({
            "id": message.id,
            "client_id": message.client_id,
            "chat_id": message.chat_id,
            "kind": message.kind or "text",
            "sender_id": message.sender_id,
            "sender_name": message.sender.display_name if message.sender else "Former member",
            "body": "" if deleted else message.body,
            "media": None if deleted else media_payload(message),
            "deleted": deleted,
            "reply_to": None if deleted else reply_summary(message),
            "created_at": iso(message.created_at),
            "expires_at": iso(message.expires_at),
            "time": format_time(message.created_at),
            "mine": message.sender_id == viewer_id,
            "status": aggregate_status(message),
            "edited": message.edited_at is not None and not deleted,
            "starred": message.id in starred and not deleted,
            "reactions": [] if deleted else [
                {"emoji": emoji, "count": count,
                    "reacted": emoji in mine[message.id]}
                for emoji, count in chips[message.id]
            ],
        })
    return payloads


def message_payload(message, viewer_id):
    return messages_payload([message], viewer_id)[0]


def chat_payload(chat, user_id):
    own_member = member_for(chat.id, user_id)
    is_group = chat.type == "group"
    other = None
    if not is_group:
        other = next(
            (member.user for member in chat.members if member.user_id != user_id), None)

    hidden = hidden_ids_for(user_id)

    latest = db.session.scalar(
        select(Message)
        .where(Message.chat_id == chat.id, Message.id.not_in(hidden), alive_clause())
        .order_by(Message.created_at.desc(), Message.id.desc())
        .limit(1))

    unread_query = select(func.count(Message.id)).where(
        Message.chat_id == chat.id,
        Message.sender_id != user_id,
        Message.deleted_at.is_(None),
        Message.kind != "system",
        Message.id.not_in(hidden),
        alive_clause(),
    )
    if own_member and own_member.last_read_at:
        unread_query = unread_query.where(
            Message.created_at > own_member.last_read_at)
    unread = db.session.scalar(unread_query) or 0

    title = chat_title(chat, user_id)
    if not latest:
        preview = "Start a conversation"
    else:
        preview = preview_core(latest)
        if is_group and latest.kind != "system" and not latest.deleted_at:
            who = "You" if latest.sender_id == user_id else (
                (latest.sender.display_name if latest.sender else "Someone").split() or ["Someone"])[0]
            preview = f"{who}: {preview}"

    stamp = latest.created_at if latest else chat.updated_at
    return {
        "id": chat.id,
        "type": chat.type,
        "title": title,
        "username": other.username if other else "",
        "other_user_id": other.id if other else None,
        "avatar_url": (other.avatar_url if other else None) or chat.avatar_url,
        "initial": avatar_initial(title),
        "preview": preview,
        "time": format_time(latest.created_at) if latest else "",
        "last_at": iso(latest.created_at) if latest else None,
        "updated_at": iso(stamp),
        "unread": unread,
        "last_message_id": latest.id if latest else None,
        "member_count": len(chat.members),
        "my_role": own_member.role if own_member else "member",
        "disappear_seconds": chat.disappear_seconds or 0,
        "online": bool(other and is_online(other.id)),
        "last_seen_at": iso(other.last_seen_at) if other and other.last_seen_at else None,
    }


def system_message(chat, actor_id, text):
    """A centred notice such as 'Ada added Maya'. Never expires, never counts as unread."""
    now = utcnow()
    message = Message(client_id=f"sys-{secrets.token_hex(12)}", chat_id=chat.id,
                      sender_id=actor_id, kind="system", body=text[:500], created_at=now)
    db.session.add(message)
    chat.updated_at = now
    return message


def delete_dependents(message_ids):
    """Remove reactions, hides and stars that point at messages about to disappear."""
    if not message_ids:
        return
    for model in (Reaction, MessageHidden, MessageStar):
        db.session.execute(
            sql_delete(model).where(model.message_id.in_(message_ids)))