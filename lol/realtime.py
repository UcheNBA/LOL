import time
from collections import defaultdict, deque

from flask import request
from flask_login import current_user
from flask_socketio import join_room
from sqlalchemy import and_, delete, or_, select
from sqlalchemy.exc import IntegrityError

from .chat_service import (aggregate_status, member_for, message_payload,
                           reaction_summary)
from .extensions import db
from .models import (Block, Chat, ChatMember, Message, MessageHidden,
                     MessageStatus, Reaction, User, utcnow)
from .presence import connect_socket, disconnect_socket, is_online

MAX_BODY = 4000
SEND_LIMIT = 20      # messages allowed ...
SEND_WINDOW = 10     # ... per this many seconds, per user
_recent_sends = defaultdict(deque)


def user_room(user_id):
    return f"user:{user_id}"


def fail(message):
    return {"ok": False, "error": message}


def to_int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def allow_send(user_id):
    now = time.monotonic()
    recent = _recent_sends[user_id]
    while recent and now - recent[0] > SEND_WINDOW:
        recent.popleft()
    if len(recent) >= SEND_LIMIT:
        return False
    recent.append(now)
    return True


def register_socket_handlers(socketio):
    # ---------- helpers ----------

    def member_ids(chat_id):
        return db.session.scalars(
            select(ChatMember.user_id).where(ChatMember.chat_id == chat_id)).all()

    def peer_ids(user_id):
        """Everyone who shares at least one chat with this user."""
        mine = select(ChatMember.chat_id).where(ChatMember.user_id == user_id)
        return db.session.scalars(
            select(ChatMember.user_id)
            .where(ChatMember.chat_id.in_(mine), ChatMember.user_id != user_id)
            .distinct()
        ).all()

    def emit_message_event(event, message):
        """Send a message payload to every member, each from their own view."""
        for uid in member_ids(message.chat_id):
            socketio.emit(event, message_payload(message, uid), to=user_room(uid))

    def notify_status(message_ids):
        """Tell each sender that the ticks on their messages changed."""
        for mid in set(message_ids):
            message = db.session.get(Message, mid)
            if message and message.sender_id:
                socketio.emit(
                    "message:status",
                    {"message_id": mid, "status": aggregate_status(message)},
                    to=user_room(message.sender_id))

    def broadcast_presence(user_id, online, last_seen=None):
        payload = {
            "user_id": user_id,
            "online": online,
            "last_seen_at": last_seen.isoformat() if last_seen else None,
        }
        for pid in peer_ids(user_id):
            socketio.emit("presence:update", payload, to=user_room(pid))

    def is_blocked(chat, sender_id):
        if chat.type != "direct":
            return False
        others = [uid for uid in member_ids(chat.id) if uid != sender_id]
        if not others:
            return False
        other = others[0]
        return db.session.scalar(
            select(Block.id).where(or_(
                and_(Block.blocker_id == other, Block.blocked_id == sender_id),
                and_(Block.blocker_id == sender_id, Block.blocked_id == other),
            ))
        ) is not None

    def mark_delivered_for(user_id):
        """Anything sent while this user was offline is now delivered."""
        pending = db.session.scalars(
            select(MessageStatus).where(
                MessageStatus.user_id == user_id,
                MessageStatus.delivered_at.is_(None))
        ).all()
        if not pending:
            return
        now = utcnow()
        touched = []
        for status in pending:
            status.delivered_at = now
            touched.append(status.message_id)
        db.session.commit()
        notify_status(touched)

    def mark_chat_read(user_id, chat_id):
        """Opening a chat reads everything in it."""
        unread = db.session.scalars(
            select(MessageStatus)
            .join(Message, Message.id == MessageStatus.message_id)
            .where(Message.chat_id == chat_id,
                   MessageStatus.user_id == user_id,
                   MessageStatus.read_at.is_(None))
        ).all()
        now = utcnow()
        touched = []
        for status in unread:
            status.read_at = now
            if not status.delivered_at:
                status.delivered_at = now
            touched.append(status.message_id)
        latest = db.session.scalar(
            select(Message).where(Message.chat_id == chat_id)
            .order_by(Message.created_at.desc(), Message.id.desc()).limit(1))
        member = member_for(chat_id, user_id)
        if member and latest:
            member.last_read_at = latest.created_at
        db.session.commit()
        notify_status(touched)

    def authed():
        return current_user if current_user.is_authenticated else None

    # ---------- connection and presence ----------

    @socketio.on("connect")
    def on_connect(auth=None):
        if not current_user.is_authenticated:
            return False
        user_id = current_user.id
        join_room(user_room(user_id))
        came_online = connect_socket(request.sid, user_id)
        mark_delivered_for(user_id)
        if came_online:
            broadcast_presence(user_id, True)

    @socketio.on("disconnect")
    def on_disconnect(*args):
        user_id, went_offline = disconnect_socket(request.sid)
        if user_id and went_offline:
            seen = utcnow()
            user = db.session.get(User, user_id)
            if user:
                user.last_seen_at = seen
                db.session.commit()
            broadcast_presence(user_id, False, seen)

    @socketio.on("chat:join")
    def on_join(data):
        user = authed()
        chat_id = to_int((data or {}).get("chat_id"))
        if not user or chat_id is None or not member_for(chat_id, user.id):
            return fail("Chat not found.")
        join_room(f"chat:{chat_id}")
        mark_chat_read(user.id, chat_id)
        return {"ok": True}

    # ---------- sending ----------

    @socketio.on("message:send")
    def on_send(data):
        user = authed()
        if not user:
            return fail("Please sign in again.")
        data = data or {}
        chat_id = to_int(data.get("chat_id"))
        body = str(data.get("body") or "").strip()
        client_id = str(data.get("client_id") or "").strip()[:64]
        if chat_id is None or not client_id:
            return fail("Message could not be sent.")
        if not body:
            return fail("Type a message first.")
        if len(body) > MAX_BODY:
            return fail(f"Messages can be up to {MAX_BODY} characters.")

        chat = db.session.get(Chat, chat_id)
        if not chat or not member_for(chat_id, user.id):
            return fail("Chat not found.")

        # Resending after a dropped connection must not create a duplicate.
        existing = db.session.scalar(
            select(Message).where(Message.client_id == client_id))
        if existing:
            if existing.sender_id == user.id and existing.chat_id == chat_id:
                return {"ok": True, "message": message_payload(existing, user.id)}
            return fail("Message could not be sent.")

        if is_blocked(chat, user.id):
            return fail("You can’t message this person.")
        if not allow_send(user.id):
            return fail("You’re sending messages too fast. Wait a moment.")

        reply_id = to_int(data.get("reply_to_id"))
        if reply_id is not None:
            parent = db.session.get(Message, reply_id)
            if not parent or parent.chat_id != chat_id or parent.deleted_at:
                reply_id = None

        now = utcnow()
        message = Message(client_id=client_id, chat_id=chat_id,
                          sender_id=user.id, body=body,
                          reply_to_id=reply_id, created_at=now)
        db.session.add(message)
        try:
            db.session.flush()
        except IntegrityError:
            db.session.rollback()
            return fail("Message could not be sent.")

        members = member_ids(chat_id)
        for uid in members:
            if uid != user.id:
                db.session.add(MessageStatus(
                    message_id=message.id, user_id=uid,
                    delivered_at=now if is_online(uid) else None))
        chat.updated_at = now
        sender_member = member_for(chat_id, user.id)
        if sender_member:
            sender_member.last_read_at = now
        is_first = db.session.scalar(
            select(Message.id).where(Message.chat_id == chat_id,
                                     Message.id != message.id).limit(1)) is None
        db.session.commit()

        emit_message_event("message:new", message)
        if is_first:
            # a brand new chat: other members' chat lists need a refresh
            for uid in members:
                if uid != user.id:
                    socketio.emit("chat:activity", {"chat_id": chat_id},
                                  to=user_room(uid))
        return {"ok": True, "message": message_payload(message, user.id)}

    @socketio.on("message:received")
    def on_received(data):
        user = authed()
        data = data or {}
        message_id = to_int(data.get("message_id"))
        if not user or message_id is None:
            return
        message = db.session.get(Message, message_id)
        if (not message or message.sender_id == user.id
                or not member_for(message.chat_id, user.id)):
            return
        status = db.session.scalar(
            select(MessageStatus).where(MessageStatus.message_id == message.id,
                                        MessageStatus.user_id == user.id))
        if not status:
            status = MessageStatus(message_id=message.id, user_id=user.id)
            db.session.add(status)
        now = utcnow()
        changed = False
        if not status.delivered_at:
            status.delivered_at = now
            changed = True
        if data.get("read") and not status.read_at:
            status.read_at = now
            changed = True
            member = member_for(message.chat_id, user.id)
            if member and (not member.last_read_at
                           or member.last_read_at < message.created_at):
                member.last_read_at = message.created_at
        if not changed:
            return
        db.session.commit()
        notify_status([message.id])

    # ---------- reactions ----------

    @socketio.on("message:react")
    def on_react(data):
        user = authed()
        data = data or {}
        message_id = to_int(data.get("message_id"))
        emoji = str(data.get("emoji") or "").strip()
        if not user or message_id is None:
            return fail("Reaction could not be saved.")
        # real emojis are never plain ASCII text
        if not emoji or len(emoji) > 16 or emoji.isascii():
            return fail("Choose an emoji.")
        message = db.session.get(Message, message_id)
        if not message or not member_for(message.chat_id, user.id):
            return fail("Message not found.")
        if message.deleted_at:
            return fail("You can’t react to a deleted message.")

        # One reaction per person: same emoji removes it, a new emoji replaces it.
        current = db.session.scalars(
            select(Reaction).where(Reaction.message_id == message.id,
                                   Reaction.user_id == user.id)).all()
        same = next((item for item in current if item.emoji == emoji), None)
        for item in current:
            db.session.delete(item)
        if not same:
            db.session.add(Reaction(message_id=message.id,
                                    user_id=user.id, emoji=emoji))
        db.session.commit()

        for uid in member_ids(message.chat_id):
            socketio.emit(
                "message:reactions",
                {"message_id": message.id,
                 "reactions": reaction_summary(message.id, uid)},
                to=user_room(uid))
        return {"ok": True, "reactions": reaction_summary(message.id, user.id)}

    # ---------- editing ----------

    @socketio.on("message:edit")
    def on_edit(data):
        user = authed()
        data = data or {}
        message_id = to_int(data.get("message_id"))
        body = str(data.get("body") or "").strip()
        if not user or message_id is None:
            return fail("Message could not be edited.")
        if not body:
            return fail("A message can’t be empty.")
        if len(body) > MAX_BODY:
            return fail(f"Messages can be up to {MAX_BODY} characters.")
        message = db.session.get(Message, message_id)
        if not message or not member_for(message.chat_id, user.id):
            return fail("Message not found.")
        if message.sender_id != user.id:
            return fail("You can only edit your own messages.")
        if message.deleted_at:
            return fail("You can’t edit a deleted message.")
        message.body = body
        message.edited_at = utcnow()
        db.session.commit()
        emit_message_event("message:updated", message)
        return {"ok": True, "message": message_payload(message, user.id)}

    # ---------- deleting ----------

    @socketio.on("message:delete")
    def on_delete(data):
        user = authed()
        data = data or {}
        message_id = to_int(data.get("message_id"))
        if not user or message_id is None:
            return fail("Message could not be deleted.")
        message = db.session.get(Message, message_id)
        if not message or not member_for(message.chat_id, user.id):
            return fail("Message not found.")

        if data.get("scope") == "everyone":
            if message.sender_id != user.id:
                return fail("You can only delete your own messages for everyone.")
            if not message.deleted_at:
                message.deleted_at = utcnow()
                message.body = ""            # the text is really gone
                message.media_url = None
                db.session.execute(
                    delete(Reaction).where(Reaction.message_id == message.id))
                db.session.commit()
            for uid in member_ids(message.chat_id):
                socketio.emit(
                    "message:deleted",
                    {"message_id": message.id, "chat_id": message.chat_id},
                    to=user_room(uid))
            return {"ok": True}

        # "me": hide it for this user only
        if not db.session.get(MessageHidden, (message.id, user.id)):
            db.session.add(MessageHidden(message_id=message.id, user_id=user.id))
            db.session.commit()
        return {"ok": True}