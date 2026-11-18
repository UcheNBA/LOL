from collections import defaultdict, deque
from time import monotonic

from flask import request
from flask_login import current_user
from flask_socketio import emit, join_room
from sqlalchemy import select

from .chat_service import member_for, message_payload
from .extensions import db
from .models import Chat, ChatMember, Message, MessageStatus, utcnow

_send_times = defaultdict(deque)


def register_socket_handlers(socketio):
    @socketio.on("chat:join")
    def join_chat(payload):
        if not current_user.is_authenticated:
            return {"ok": False, "error": "Sign in required."}
        try:
            chat_id = int((payload or {}).get("chat_id"))
        except (TypeError, ValueError):
            return {"ok": False, "error": "Invalid chat."}
        if not member_for(chat_id, current_user.id):
            return {"ok": False, "error": "Chat not found."}
        join_room(f"chat:{chat_id}")
        status_updates = []
        read_at = utcnow()
        pending_statuses = db.session.scalars(
            select(MessageStatus)
            .join(Message, MessageStatus.message_id == Message.id)
            .where(
                Message.chat_id == chat_id,
                MessageStatus.user_id == current_user.id,
                MessageStatus.read_at.is_(None),
            )
        ).all()
        for status in pending_statuses:
            status.delivered_at = status.delivered_at or read_at
            status.read_at = read_at
            status_updates.append(status.message_id)
        own_member = member_for(chat_id, current_user.id)
        if pending_statuses or not own_member.last_read_at:
            own_member.last_read_at = read_at
        db.session.commit()
        for message_id in status_updates:
            socketio.emit("message:status", {
                          "message_id": message_id, "status": "read"}, to=f"chat:{chat_id}")
        return {"ok": True}

    @socketio.on("message:send")
    def send_message(payload):
        if not current_user.is_authenticated:
            return {"ok": False, "error": "Sign in required."}
        payload = payload or {}
        try:
            chat_id = int(payload.get("chat_id"))
        except (TypeError, ValueError):
            return {"ok": False, "error": "Invalid chat."}
        member = member_for(chat_id, current_user.id)
        if not member:
            return {"ok": False, "error": "Chat not found."}
        body = str(payload.get("body", "")).strip()
        client_id = str(payload.get("client_id", ""))
        if not body or len(body) > 4000 or len(client_id) > 64 or not client_id:
            return {"ok": False, "error": "Message must contain 1-4000 characters."}
        now = monotonic()
        recent = _send_times[current_user.id]
        while recent and now - recent[0] > 60:
            recent.popleft()
        if len(recent) >= 30:
            return {"ok": False, "error": "You are sending messages too quickly."}
        recent.append(now)

        message = db.session.scalar(
            select(Message).where(Message.client_id == client_id))
        if message:
            if message.sender_id != current_user.id or message.chat_id != chat_id:
                return {"ok": False, "error": "Message identifier already used."}
            return {"ok": True, "message": message_payload(message, current_user.id)}

        chat = db.session.get(Chat, chat_id)
        message = Message(
            chat_id=chat_id, sender_id=current_user.id, body=body, client_id=client_id)
        db.session.add(message)
        db.session.flush()
        recipients = db.session.scalars(select(ChatMember.user_id).where(
            ChatMember.chat_id == chat_id,
            ChatMember.user_id != current_user.id,
        )).all()
        for recipient_id in recipients:
            db.session.add(MessageStatus(
                message_id=message.id, user_id=recipient_id))
        chat.updated_at = utcnow()
        db.session.commit()
        data = message_payload(message, current_user.id)
        socketio.emit("message:new", data, to=f"chat:{chat_id}")
        for recipient_id in recipients:
            socketio.emit("chat:activity", {
                          "chat_id": chat_id}, to=f"user:{recipient_id}")
        socketio.emit("chat:activity", {
                      "chat_id": chat_id}, to=f"user:{current_user.id}")
        return {"ok": True, "message": data}

    @socketio.on("message:received")
    def receive_message(payload):
        if not current_user.is_authenticated:
            return {"ok": False}
        payload = payload or {}
        try:
            message_id = int(payload.get("message_id"))
        except (TypeError, ValueError):
            return {"ok": False}
        status = db.session.scalar(select(MessageStatus).where(
            MessageStatus.message_id == message_id,
            MessageStatus.user_id == current_user.id,
        ))
        if not status or not member_for(status.message.chat_id, current_user.id):
            return {"ok": False}
        status.delivered_at = status.delivered_at or utcnow()
        if payload.get("read") and not status.read_at:
            status.read_at = utcnow()
            member_for(status.message.chat_id,
                       current_user.id).last_read_at = status.read_at
        db.session.commit()
        socketio.emit("message:status", {
            "message_id": message_id,
            "status": "read" if status.read_at else "delivered",
        }, to=f"chat:{status.message.chat_id}")
        return {"ok": True}

    @socketio.on("connect")
    def connected(auth=None):
        if current_user.is_authenticated:
            join_room(f"user:{current_user.id}")
            memberships = db.session.scalars(
                select(ChatMember.chat_id).where(
                    ChatMember.user_id == current_user.id)
            ).all()
            for chat_id in memberships:
                join_room(f"chat:{chat_id}")
