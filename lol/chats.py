import re

from flask import Blueprint, current_app, jsonify, request
from flask_login import current_user, login_required
from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import selectinload

from .chat_service import (chat_payload, hidden_ids_for, member_for,
                           message_payload, messages_payload)
from .extensions import db, limiter
from .models import Chat, ChatMember, Contact, Message, MessageStatus, User, utcnow

chats_bp = Blueprint("chats", __name__, url_prefix="/api")


@chats_bp.get("/users")
@login_required
def search_users():
    query = request.args.get("q", "").strip().lower()
    if len(query) < 2:
        return jsonify({"users": []})
    pattern = f"%{query}%"
    users = db.session.scalars(
        select(User).where(
            User.id != current_user.id,
            or_(User.username.ilike(pattern), User.email.ilike(pattern),
                User.phone.ilike(pattern), User.display_name.ilike(pattern)),
        ).order_by(User.username).limit(12)
    ).all()
    return jsonify({"users": [{
        "id": user.id,
        "username": user.username,
        "display_name": user.display_name,
        "avatar_url": user.avatar_url,
        "initial": (user.display_name or user.username)[:1].upper(),
        "about": user.about,
    } for user in users]})


@chats_bp.post("/chats")
@login_required
@limiter.limit("20 per minute")
def start_chat():
    payload = request.get_json(silent=True) or {}
    try:
        other_id = int(payload.get("user_id"))
    except (TypeError, ValueError):
        return jsonify({"error": "Choose a valid user."}), 400
    if other_id == current_user.id:
        return jsonify({"error": "You cannot start a chat with yourself."}), 400
    other = db.session.get(User, other_id)
    if not other:
        return jsonify({"error": "User not found."}), 404

    # One query: a direct chat that both people belong to.
    mine = select(ChatMember.chat_id).where(
        ChatMember.user_id == current_user.id)
    theirs = select(ChatMember.chat_id).where(ChatMember.user_id == other_id)
    chat = db.session.scalar(
        select(Chat).where(Chat.type == "direct",
                           Chat.id.in_(mine), Chat.id.in_(theirs)).limit(1))

    created = False
    if not chat:
        created = True
        chat = Chat(type="direct", creator_id=current_user.id)
        db.session.add(chat)
        db.session.flush()
        rows = [
            ChatMember(chat_id=chat.id,
                       user_id=current_user.id, role="member"),
            ChatMember(chat_id=chat.id, user_id=other.id, role="member"),
        ]
        has_contact = db.session.scalar(select(Contact.id).where(
            Contact.owner_id == current_user.id, Contact.contact_id == other.id))
        if not has_contact:
            rows.append(Contact(owner_id=current_user.id,
                        contact_id=other.id))
        db.session.add_all(rows)
        db.session.commit()

    return jsonify({
        "chat_id": chat.id,
        "chat": chat_payload(chat, current_user.id),
        "created": created,
    })


@chats_bp.get("/chats")
@login_required
def list_chats():
    chats = db.session.scalars(
        select(Chat).join(ChatMember).where(ChatMember.user_id ==
                                            current_user.id).order_by(Chat.updated_at.desc())
    ).all()
    return jsonify({"chats": [chat_payload(chat, current_user.id) for chat in chats]})


@chats_bp.get("/chats/<int:chat_id>/messages")
@login_required
def list_messages(chat_id):
    if not member_for(chat_id, current_user.id):
        return jsonify({"error": "Chat not found."}), 404
    try:
        before_id = int(request.args.get("before", "0"))
    except ValueError:
        return jsonify({"error": "Invalid message cursor."}), 400

    # Messages this user chose to "delete for me" never come back.
    query = select(Message).where(
        Message.chat_id == chat_id,
        Message.id.not_in(hidden_ids_for(current_user.id)),
    )
    if before_id:
        cursor = db.session.get(Message, before_id)
        if not cursor or cursor.chat_id != chat_id:
            return jsonify({"error": "Invalid message cursor."}), 400
        query = query.where(Message.id < before_id)

    messages = db.session.scalars(
        query.options(selectinload(Message.statuses),
                      selectinload(Message.sender))
        .order_by(Message.created_at.desc(), Message.id.desc())
        .limit(30)
    ).all()
    messages.reverse()
    return jsonify({"messages": messages_payload(messages, current_user.id),
                    "has_more": len(messages) == 30})


@chats_bp.get("/chats/<int:chat_id>")
@login_required
def get_chat(chat_id):
    chat = db.session.get(Chat, chat_id)
    if not chat or not member_for(chat_id, current_user.id):
        return jsonify({"error": "Chat not found."}), 404
    return jsonify({"chat": chat_payload(chat, current_user.id)})