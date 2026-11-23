from datetime import datetime

from sqlalchemy import func, select

from .extensions import db
from .models import (Chat, ChatMember, Message, MessageHidden, MessageStatus,
                     Reaction, User, utcnow)
from .presence import is_online

DELETED_PREVIEW = "🚫 Message deleted"


def format_time(value):
    rendered = value.astimezone().strftime(
        "%I:%M %p") if value.tzinfo else value.strftime("%I:%M %p")
    return rendered.lstrip("0")


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
    """sent / delivered / read, as seen by the sender."""
    recipients = [
        status for status in message.statuses if status.user_id != message.sender_id]
    if recipients and all(status.read_at for status in recipients):
        return "read"
    if recipients and all(status.delivered_at for status in recipients):
        return "delivered"
    return "sent"


def reaction_summary(message_id, viewer_id):
    """Reaction chips for one message, from one viewer's point of view."""
    counts = db.session.execute(
        select(Reaction.emoji, func.count(Reaction.id))
        .where(Reaction.message_id == message_id)
        .group_by(Reaction.emoji)
        .order_by(func.min(Reaction.id))
    ).all()
    mine = set(db.session.scalars(
        select(Reaction.emoji).where(
            Reaction.message_id == message_id,
            Reaction.user_id == viewer_id,
        )
    ).all())
    return [{"emoji": emoji, "count": count, "reacted": emoji in mine}
            for emoji, count in counts]


def reply_payload(message):
    """A small summary of the message being replied to."""
    if not message.reply_to_id:
        return None
    parent = db.session.get(Message, message.reply_to_id)
    if not parent:
        return None
    deleted = parent.deleted_at is not None
    return {
        "id": parent.id,
        "sender_id": parent.sender_id,
        "sender_name": parent.sender.display_name if parent.sender else "Former member",
        "body": "" if deleted else (parent.body or "")[:200],
        "deleted": deleted,
    }


def message_payload(message, viewer_id):
    deleted = message.deleted_at is not None
    return {
        "id": message.id,
        "client_id": message.client_id,
        "chat_id": message.chat_id,
        "sender_id": message.sender_id,
        "sender_name": message.sender.display_name if message.sender else "Former member",
        # a deleted message never sends its text to anyone
        "body": "" if deleted else message.body,
        "deleted": deleted,
        "reply_to": None if deleted else reply_payload(message),
        "created_at": message.created_at.isoformat(),
        "time": format_time(message.created_at),
        "mine": message.sender_id == viewer_id,
        "status": aggregate_status(message),
        "edited": message.edited_at is not None and not deleted,
        "reactions": [] if deleted else reaction_summary(message.id, viewer_id),
    }


def chat_payload(chat, user_id):
    own_member = member_for(chat.id, user_id)
    other = next(
        (member.user for member in chat.members if member.user_id != user_id), None)

    hidden = hidden_ids_for(user_id)

    latest = db.session.scalar(
        select(Message)
        .where(Message.chat_id == chat.id, Message.id.not_in(hidden))
        .order_by(Message.created_at.desc(), Message.id.desc())
        .limit(1))

    unread_query = select(func.count(Message.id)).where(
        Message.chat_id == chat.id,
        Message.sender_id != user_id,
        Message.deleted_at.is_(None),
        Message.id.not_in(hidden),
    )
    if own_member.last_read_at:
        unread_query = unread_query.where(
            Message.created_at > own_member.last_read_at)
    unread = db.session.scalar(unread_query) or 0

    title = chat_title(chat, user_id)
    if not latest:
        preview = "Start a conversation"
    elif latest.deleted_at:
        preview = DELETED_PREVIEW
    else:
        preview = latest.body
    other_online = bool(other and is_online(other.id))
    return {
        "id": chat.id,
        "title": title,
        "username": other.username if other else "",
        "other_user_id": other.id if other else None,
        "avatar_url": (other.avatar_url if other else None) or chat.avatar_url,
        "initial": avatar_initial(title),
        "preview": preview,
        "time": format_time(latest.created_at) if latest else "",
        "updated_at": (latest.created_at if latest else chat.updated_at).isoformat(),
        "unread": unread,
        "last_message_id": latest.id if latest else None,
        "online": other_online,
        "last_seen_at": other.last_seen_at.isoformat() if other and other.last_seen_at else None,
    }