from flask import Blueprint, jsonify, request
from flask_login import current_user, login_required
from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import selectinload

from .chat_service import (alive_clause, chat_payload, chat_title,
                           delete_dependents, hidden_ids_for, is_online,
                           member_for, messages_payload, system_message)
from .events import (broadcast_message, join_chat_room, leave_chat_room,
                     refresh_chat_lists)
from .extensions import db, limiter
from .media import remove_media_files
from .models import (Chat, ChatMember, Contact, Message, MessageStar, User,
                     utcnow)

chats_bp = Blueprint("chats", __name__, url_prefix="/api")

DISAPPEAR_LABELS = {86400: "24 hours", 604800: "7 days", 7776000: "90 days"}
MAX_GROUP_MEMBERS = 256


def json_error(message, status=400):
    return jsonify({"error": message}), status


def is_admin(chat_id, user_id):
    member = member_for(chat_id, user_id)
    return bool(member and member.role == "admin")


def member_ids_of(chat_id):
    return db.session.scalars(
        select(ChatMember.user_id).where(ChatMember.chat_id == chat_id)).all()


def parse_ids(values):
    try:
        return {int(value) for value in (values or [])}
    except (TypeError, ValueError):
        return None


def group_for(chat_id):
    """The group, but only if the signed-in user belongs to it."""
    chat = db.session.get(Chat, chat_id)
    if not chat or chat.type != "group" or not member_for(chat_id, current_user.id):
        return None
    return chat


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
        return json_error("Choose a valid user.")
    if other_id == current_user.id:
        return json_error("You cannot start a chat with yourself.")
    other = db.session.get(User, other_id)
    if not other:
        return json_error("User not found.", 404)

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
        join_chat_room(current_user.id, chat.id)
        join_chat_room(other.id, chat.id)

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
        return json_error("Chat not found.", 404)
    try:
        before_id = int(request.args.get("before", "0"))
    except ValueError:
        return json_error("Invalid message cursor.")

    query = select(Message).where(
        Message.chat_id == chat_id,
        Message.id.not_in(hidden_ids_for(current_user.id)),
        alive_clause(),
    )
    if before_id:
        cursor = db.session.get(Message, before_id)
        if not cursor or cursor.chat_id != chat_id:
            return json_error("Invalid message cursor.")
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
        return json_error("Chat not found.", 404)
    return jsonify({"chat": chat_payload(chat, current_user.id)})


# ---------- groups ----------

@chats_bp.post("/groups")
@login_required
@limiter.limit("10 per minute")
def create_group():
    data = request.get_json(silent=True) or {}
    name = str(data.get("name") or "").strip()
    if not name or len(name) > 80:
        return json_error("Give the group a name (up to 80 characters).")
    ids = parse_ids(data.get("member_ids"))
    if ids is None:
        return json_error("Choose valid people.")
    ids.discard(current_user.id)
    if not ids:
        return json_error("Add at least one person.")
    if len(ids) + 1 > MAX_GROUP_MEMBERS:
        return json_error(f"Groups can have up to {MAX_GROUP_MEMBERS} people.")
    users = db.session.scalars(select(User).where(User.id.in_(ids))).all()
    if len(users) != len(ids):
        return json_error("Some of those people could not be found.", 404)

    chat = Chat(type="group", name=name, creator_id=current_user.id)
    db.session.add(chat)
    db.session.flush()
    db.session.add(ChatMember(chat_id=chat.id,
                   user_id=current_user.id, role="admin"))
    for user in users:
        db.session.add(ChatMember(chat_id=chat.id,
                       user_id=user.id, role="member"))
    notice = system_message(
        chat, current_user.id, f"{current_user.display_name} created the group “{name}”")
    db.session.commit()

    everyone = [current_user.id, *ids]
    for user_id in everyone:
        join_chat_room(user_id, chat.id)
    broadcast_message(notice)
    refresh_chat_lists(everyone, chat.id)
    return jsonify({"chat": chat_payload(chat, current_user.id)})


@chats_bp.get("/chats/<int:chat_id>/members")
@login_required
def list_members(chat_id):
    if not member_for(chat_id, current_user.id):
        return json_error("Chat not found.", 404)
    rows = db.session.scalars(
        select(ChatMember).where(ChatMember.chat_id == chat_id)
        .options(selectinload(ChatMember.user))
        .order_by(ChatMember.role, ChatMember.joined_at, ChatMember.id)
    ).all()
    return jsonify({"members": [{
        "id": row.user_id,
        "display_name": row.user.display_name,
        "username": row.user.username,
        "avatar_url": row.user.avatar_url,
        "initial": (row.user.display_name or "?")[:1].upper(),
        "role": row.role,
        "online": is_online(row.user_id),
        "me": row.user_id == current_user.id,
    } for row in rows]})


@chats_bp.post("/chats/<int:chat_id>/members")
@login_required
@limiter.limit("30 per minute")
def add_members(chat_id):
    chat = group_for(chat_id)
    if not chat:
        return json_error("Group not found.", 404)
    if not is_admin(chat_id, current_user.id):
        return json_error("Only group admins can add people.", 403)
    data = request.get_json(silent=True) or {}
    ids = parse_ids(data.get("user_ids"))
    if not ids:
        return json_error("Choose at least one person.")
    existing = set(member_ids_of(chat_id))
    new_ids = ids - existing
    if not new_ids:
        return json_error("They are already in this group.")
    if len(existing) + len(new_ids) > MAX_GROUP_MEMBERS:
        return json_error(f"Groups can have up to {MAX_GROUP_MEMBERS} people.")
    users = db.session.scalars(select(User).where(User.id.in_(new_ids))).all()
    if len(users) != len(new_ids):
        return json_error("Some of those people could not be found.", 404)

    for user in users:
        db.session.add(ChatMember(chat_id=chat_id,
                       user_id=user.id, role="member"))
    names = ", ".join(user.display_name for user in users)
    notice = system_message(
        chat, current_user.id, f"{current_user.display_name} added {names}")
    db.session.commit()

    for user in users:
        join_chat_room(user.id, chat_id)
    broadcast_message(notice)
    refresh_chat_lists([*existing, *new_ids], chat_id)
    return jsonify({"ok": True})


@chats_bp.delete("/chats/<int:chat_id>/members/<int:user_id>")
@login_required
def remove_member(chat_id, user_id):
    chat = group_for(chat_id)
    if not chat:
        return json_error("Group not found.", 404)
    leaving = user_id == current_user.id
    if not leaving and not is_admin(chat_id, current_user.id):
        return json_error("Only group admins can remove people.", 403)
    target = member_for(chat_id, user_id)
    if not target:
        return json_error("That person isn’t in this group.", 404)

    remaining = [uid for uid in member_ids_of(chat_id) if uid != user_id]
    if not remaining:
        # the last person left: the group goes away completely
        messages = db.session.scalars(
            select(Message).where(Message.chat_id == chat_id)).all()
        remove_media_files(messages)
        delete_dependents([message.id for message in messages])
        db.session.delete(chat)
        db.session.commit()
        leave_chat_room(user_id, chat_id)
        refresh_chat_lists([user_id], chat_id)
        return jsonify({"ok": True, "deleted": True})

    target_user = target.user
    text = (f"{current_user.display_name} left" if leaving
            else f"{current_user.display_name} removed {target_user.display_name}")
    notice = system_message(chat, current_user.id, text)
    was_admin = target.role == "admin"
    db.session.delete(target)
    db.session.flush()
    if was_admin and not db.session.scalar(
            select(ChatMember.id).where(ChatMember.chat_id == chat_id, ChatMember.role == "admin")):
        heir = db.session.scalar(
            select(ChatMember).where(ChatMember.chat_id == chat_id)
            .order_by(ChatMember.joined_at, ChatMember.id).limit(1))
        heir.role = "admin"
    db.session.commit()

    broadcast_message(notice)          # before they leave the live room
    leave_chat_room(user_id, chat_id)
    refresh_chat_lists([user_id, *remaining], chat_id)
    return jsonify({"ok": True})


@chats_bp.post("/chats/<int:chat_id>/members/<int:user_id>/role")
@login_required
def set_role(chat_id, user_id):
    chat = group_for(chat_id)
    if not chat:
        return json_error("Group not found.", 404)
    if not is_admin(chat_id, current_user.id):
        return json_error("Only group admins can change roles.", 403)
    role = (request.get_json(silent=True) or {}).get("role")
    if role not in ("admin", "member"):
        return json_error("Choose admin or member.")
    target = member_for(chat_id, user_id)
    if not target:
        return json_error("That person isn’t in this group.", 404)
    if role == "member" and target.role == "admin":
        admins = db.session.scalar(select(func.count(ChatMember.id)).where(
            ChatMember.chat_id == chat_id, ChatMember.role == "admin")) or 0
        if admins <= 1:
            return json_error("A group needs at least one admin.")
    if target.role == role:
        return jsonify({"ok": True})
    target.role = role
    text = (f"{current_user.display_name} made {target.user.display_name} an admin" if role == "admin"
            else f"{current_user.display_name} removed {target.user.display_name} as admin")
    notice = system_message(chat, current_user.id, text)
    db.session.commit()
    broadcast_message(notice)
    refresh_chat_lists(member_ids_of(chat_id), chat_id)
    return jsonify({"ok": True})


@chats_bp.patch("/chats/<int:chat_id>")
@login_required
@limiter.limit("30 per minute")
def update_chat(chat_id):
    chat = db.session.get(Chat, chat_id)
    if not chat or not member_for(chat_id, current_user.id):
        return json_error("Chat not found.", 404)
    data = request.get_json(silent=True) or {}
    admin = is_admin(chat_id, current_user.id)
    notices = []

    if "name" in data:
        if chat.type != "group":
            return json_error("Only groups have names.")
        if not admin:
            return json_error("Only group admins can rename the group.", 403)
        name = str(data.get("name") or "").strip()
        if not name or len(name) > 80:
            return json_error("Give the group a name (up to 80 characters).")
        if name != chat.name:
            chat.name = name
            notices.append(system_message(
                chat, current_user.id, f"{current_user.display_name} renamed the group to “{name}”"))

    if "disappear_seconds" in data:
        try:
            seconds = int(data.get("disappear_seconds"))
        except (TypeError, ValueError):
            return json_error("Choose a valid time.")
        if seconds != 0 and seconds not in DISAPPEAR_LABELS:
            return json_error("Choose a valid time.")
        if chat.type == "group" and not admin:
            return json_error("Only group admins can change disappearing messages.", 403)
        if seconds != (chat.disappear_seconds or 0):
            chat.disappear_seconds = seconds
            text = (f"{current_user.display_name} turned on disappearing messages ({DISAPPEAR_LABELS[seconds]})"
                    if seconds else f"{current_user.display_name} turned off disappearing messages")
            notices.append(system_message(chat, current_user.id, text))

    db.session.commit()
    for notice in notices:
        broadcast_message(notice)
    if notices:
        refresh_chat_lists(member_ids_of(chat_id), chat_id)
    return jsonify({"chat": chat_payload(chat, current_user.id)})


# ---------- starred messages ----------

@chats_bp.get("/starred")
@login_required
def list_starred():
    messages = db.session.execute(
        select(Message)
        .join(MessageStar, MessageStar.message_id == Message.id)
        .join(ChatMember, and_(ChatMember.chat_id == Message.chat_id,
                               ChatMember.user_id == current_user.id))
        .where(MessageStar.user_id == current_user.id,
               Message.deleted_at.is_(None),
               Message.id.not_in(hidden_ids_for(current_user.id)),
               alive_clause())
        .order_by(MessageStar.created_at.desc())
        .limit(200)
        .options(selectinload(Message.statuses), selectinload(Message.sender))
    ).scalars().all()

    chat_ids = {message.chat_id for message in messages}
    chats = {}
    if chat_ids:
        chats = {chat.id: chat for chat in db.session.scalars(
            select(Chat).where(Chat.id.in_(chat_ids))
            .options(selectinload(Chat.members).selectinload(ChatMember.user))
        ).all()}

    payloads = messages_payload(messages, current_user.id)
    for payload in payloads:
        chat = chats.get(payload["chat_id"])
        payload["chat_title"] = chat_title(chat, current_user.id) if chat else "Chat"
    return jsonify({"starred": payloads})