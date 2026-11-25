import os
import re
import secrets
import time
from datetime import timedelta

from flask import Blueprint, abort, current_app, jsonify, request, send_file
from flask_login import current_user, login_required
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from . import socketio
from .chat_service import (as_utc, delete_dependents, member_for,
                           message_payload)
from .events import broadcast_message, refresh_chat_lists
from .extensions import db, limiter
from .models import Chat, ChatMember, Message, MessageStatus, utcnow

media_bp = Blueprint("media", __name__, url_prefix="/api")

IMAGE_EXT = {"png", "jpg", "jpeg", "gif", "webp"}
AUDIO_EXT = {"webm", "ogg", "oga", "mp3", "m4a", "mp4", "wav", "aac"}
DOC_EXT = {"pdf", "txt", "csv", "doc", "docx", "xls", "xlsx",
           "ppt", "pptx", "zip", "rtf", "odt"}
MIME = {
    "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
    "gif": "image/gif", "webp": "image/webp",
    "webm": "audio/webm", "ogg": "audio/ogg", "oga": "audio/ogg",
    "mp3": "audio/mpeg", "m4a": "audio/mp4", "mp4": "audio/mp4",
    "wav": "audio/wav", "aac": "audio/aac",
}


def upload_dir():
    return current_app.config["UPLOAD_DIR"]


def failure(message, status=400):
    return jsonify({"ok": False, "error": message}), status


def clean_name(raw):
    name = os.path.basename(str(raw or "").replace("\\", "/"))
    name = re.sub(r"[\x00-\x1f\x7f]", "", name).strip()[:255]
    return name or "file"


def looks_like_image(head, ext):
    """Check the first bytes, so a renamed .exe can't pass as a picture."""
    if ext == "png":
        return head.startswith(b"\x89PNG")
    if ext in ("jpg", "jpeg"):
        return head.startswith(b"\xff\xd8\xff")
    if ext == "gif":
        return head[:4] == b"GIF8"
    if ext == "webp":
        return head[:4] == b"RIFF" and head[8:12] == b"WEBP"
    return False


def remove_media_files(messages):
    for message in messages:
        if not message.media_url:
            continue
        path = os.path.join(upload_dir(), os.path.basename(message.media_url))
        try:
            os.remove(path)
        except OSError:
            pass


@media_bp.post("/chats/<int:chat_id>/upload")
@login_required
@limiter.limit("30 per minute")
def upload(chat_id):
    chat = db.session.get(Chat, chat_id)
    if not chat or not member_for(chat_id, current_user.id):
        return failure("Chat not found.", 404)

    file = request.files.get("file")
    if not file or not file.filename:
        return failure("Choose a file to send.")

    client_id = str(request.form.get("client_id") or "").strip()[
        :64] or secrets.token_hex(16)
    existing = db.session.scalar(
        select(Message).where(Message.client_id == client_id))
    if existing:                      # a retry after a dropped connection
        if existing.sender_id == current_user.id and existing.chat_id == chat_id:
            return jsonify({"ok": True, "message": message_payload(existing, current_user.id)})
        return failure("Message identifier already used.")

    shown_name = clean_name(file.filename)
    ext = os.path.splitext(shown_name)[1].lstrip(".").lower()
    wants_voice = request.form.get("kind") == "voice"
    head = file.stream.read(16)
    file.stream.seek(0)

    if wants_voice and ext in AUDIO_EXT:
        kind = "voice"
    elif ext in IMAGE_EXT:
        if not looks_like_image(head, ext):
            return failure("That image looks damaged or isn’t a real picture.")
        kind = "image"
    elif ext in DOC_EXT or ext in AUDIO_EXT:
        kind = "file"
    else:
        return failure("That file type isn’t supported.")

    stored = f"{secrets.token_hex(16)}.{ext}"
    path = os.path.join(upload_dir(), stored)
    file.save(path)
    size = os.path.getsize(path)
    if size == 0:
        os.remove(path)
        return failure("That file is empty.")

    caption = "" if kind == "voice" else str(
        request.form.get("body") or "").strip()[:1000]
    try:
        duration = max(0, min(int(float(request.form.get("duration") or 0)), 3600))
    except ValueError:
        duration = 0

    reply_id = None
    try:
        requested = int(request.form.get("reply_to_id"))
    except (TypeError, ValueError):
        requested = None
    if requested is not None:
        parent = db.session.get(Message, requested)
        if (parent and parent.chat_id == chat_id and parent.deleted_at is None
                and parent.kind != "system"):
            reply_id = parent.id

    now = utcnow()
    expires_at = now + \
        timedelta(seconds=chat.disappear_seconds) if chat.disappear_seconds else None
    message = Message(
        client_id=client_id, chat_id=chat_id, sender_id=current_user.id, kind=kind,
        body=caption, media_url=stored, media_name=shown_name, media_size=size,
        media_duration=duration if kind == "voice" else None,
        reply_to_id=reply_id, created_at=now, expires_at=expires_at)
    db.session.add(message)
    try:
        db.session.flush()
    except IntegrityError:
        db.session.rollback()
        os.remove(path)
        return failure("Message could not be sent.")

    members = db.session.scalars(
        select(ChatMember.user_id).where(ChatMember.chat_id == chat_id)).all()
    for user_id in members:
        if user_id != current_user.id:
            db.session.add(MessageStatus(
                message_id=message.id, user_id=user_id))
    chat.updated_at = now
    db.session.commit()

    broadcast_message(message)
    refresh_chat_lists(members, chat_id)
    return jsonify({"ok": True, "message": message_payload(message, current_user.id)})


@media_bp.get("/messages/<int:message_id>/media")
@login_required
def media(message_id):
    """Files are private: only people in the chat can open them."""
    message = db.session.get(Message, message_id)
    if (not message or not message.media_url or message.deleted_at
            or not member_for(message.chat_id, current_user.id)):
        abort(404)
    if message.expires_at and as_utc(message.expires_at) <= utcnow():
        abort(404)
    name = os.path.basename(message.media_url)
    path = os.path.join(upload_dir(), name)
    if not os.path.isfile(path):
        abort(404)
    ext = name.rsplit(".", 1)[-1].lower()
    inline = message.kind in ("image", "voice")
    response = send_file(
        path, mimetype=MIME.get(ext, "application/octet-stream"),
        as_attachment=not inline, download_name=message.media_name or name,
        conditional=True, max_age=3600)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.cache_control.public = None
    response.cache_control.private = True
    return response


# ---------- disappearing messages ----------

def purge_expired():
    expired = db.session.scalars(
        select(Message).where(Message.expires_at.is_not(None),
                              Message.expires_at <= utcnow()).limit(500)).all()
    if not expired:
        return 0
    chat_ids = {message.chat_id for message in expired}
    remove_media_files(expired)
    delete_dependents([message.id for message in expired])
    for message in expired:
        db.session.delete(message)
    db.session.commit()
    for chat_id in chat_ids:
        members = db.session.scalars(
            select(ChatMember.user_id).where(ChatMember.chat_id == chat_id)).all()
        refresh_chat_lists(members, chat_id)
    return len(expired)


def start_purger(app, interval=60):
    def loop():
        while True:
            time.sleep(interval)
            try:
                with app.app_context():
                    purge_expired()
            except Exception:
                app.logger.exception("Purging expired messages failed")

    socketio.start_background_task(loop)