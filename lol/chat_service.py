from datetime import datetime

from sqlalchemy import func, select

from .extensions import db
from .models import Chat, ChatMember, Message, MessageStatus, Reaction, User, utcnow
from .presence import is_online


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


def message_payload(message, viewer_id):
    recipient_statuses = [
        status for status in message.statuses if status.user_id != message.sender_id]
    read = bool(recipient_statuses) and all(
        status.read_at for status in recipient_statuses)
    delivered = bool(recipient_statuses) and all(
        status.delivered_at for status in recipient_statuses)
    reaction_counts = db.session.execute(
        select(Reaction.emoji, db.func.count(Reaction.id))
        .where(Reaction.message_id == message.id)
        .group_by(Reaction.emoji)
    ).all()
    viewer_reactions = set(db.session.scalars(
        select(Reaction.emoji).where(
            Reaction.message_id == message.id,
            Reaction.user_id == viewer_id,
        )
    ).all())
    return {
        "id": message.id,
        "client_id": message.client_id,
        "chat_id": message.chat_id,
        "sender_id": message.sender_id,
        "sender_name": message.sender.display_name if message.sender else "Former member",
        "body": message.body,
        "created_at": message.created_at.isoformat(),
        "time": format_time(message.created_at),
        "mine": message.sender_id == viewer_id,
        "status": "read" if read else "delivered" if delivered else "sent",
        "edited": message.edited_at is not None,
        "reactions": [
            {"emoji": emoji, "count": count, "reacted": emoji in viewer_reactions}
            for emoji, count in reaction_counts
        ],
    }


def chat_payload(chat, user_id):
    own_member = member_for(chat.id, user_id)
    other = next(
        (member.user for member in chat.members if member.user_id != user_id), None)
    latest = db.session.scalar(select(Message).where(Message.chat_id == chat.id).order_by(
        Message.created_at.desc(), Message.id.desc()).limit(1))
    unread_query = select(func.count(Message.id)).where(
        Message.chat_id == chat.id,
        Message.sender_id != user_id,
    )
    if own_member.last_read_at:
        unread_query = unread_query.where(
            Message.created_at > own_member.last_read_at)
    unread = db.session.scalar(unread_query) or 0
    title = chat_title(chat, user_id)
    preview = latest.body if latest else "Start a conversation"
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
