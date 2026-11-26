import mimetypes
import os
import re
import secrets
import time
from datetime import timedelta
from urllib.parse import quote

from flask import (Blueprint, abort, current_app, jsonify, redirect, request,
                   send_file)
from flask_login import current_user, login_required
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

try:
    import cloudinary
    import cloudinary.uploader
    import cloudinary.utils
except ImportError:          # package not installed: fall back to local files
    cloudinary = None

try:
    import boto3
    from botocore.config import Config as BotoConfig
except ImportError:          # package not installed: fall back to local files
    boto3 = None
    BotoConfig = None

from . import socketio
from .chat_service import (as_utc, delete_dependents, member_for,
                           message_payload)
from .events import broadcast_message, refresh_chat_lists
from .extensions import db, limiter
from .models import Chat, ChatMember, Message, MessageStatus, utcnow

media_bp = Blueprint("media", __name__, url_prefix="/api")

IMAGE_EXT = {"png", "jpg", "jpeg", "gif", "webp"}
VIDEO_EXT = {"mp4", "webm", "mov", "m4v"}
AUDIO_EXT = {"webm", "ogg", "oga", "mp3", "m4a", "mp4", "wav", "aac"}
DOC_EXT = {"pdf", "txt", "csv", "doc", "docx", "xls", "xlsx",
           "ppt", "pptx", "zip", "rtf", "odt"}
AUDIO_MIME = {
    "webm": "audio/webm", "ogg": "audio/ogg", "oga": "audio/ogg",
    "mp3": "audio/mpeg", "m4a": "audio/mp4", "mp4": "audio/mp4",
    "wav": "audio/wav", "aac": "audio/aac",
}
VIDEO_MIME = {
    "mp4": "video/mp4", "webm": "video/webm",
    "mov": "video/quicktime", "m4v": "video/x-m4v",
}
IMAGE_MIME = {
    "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
    "gif": "image/gif", "webp": "image/webp",
}
CLOUD_PREFIX = "cld|"      # pictures (and older files) kept in Cloudinary
R2_PREFIX = "r2|"          # voice notes, videos, documents kept in Cloudflare R2
LINK_SECONDS = 6 * 3600    # how long a signed R2 link works


def content_type_for(kind, ext):
    if kind == "video":
        return VIDEO_MIME.get(ext, "video/mp4")
    if kind == "voice":
        return AUDIO_MIME.get(ext, "audio/webm")
    if kind == "image":
        return IMAGE_MIME.get(ext, "application/octet-stream")
    return (AUDIO_MIME.get(ext) or mimetypes.types_map.get(f".{ext}")
            or "application/octet-stream")


# ---------- Cloudinary (pictures) ----------

_cloud = {"checked": False, "ready": False}


def cloud_ready():
    if not _cloud["checked"]:
        _cloud["checked"] = True
        _cloud["ready"] = _configure_cloud()
    return _cloud["ready"]


def _configure_cloud():
    if cloudinary is None:
        return False
    name = os.environ.get("CLOUDINARY_CLOUD_NAME")
    key = os.environ.get("CLOUDINARY_API_KEY")
    secret = os.environ.get("CLOUDINARY_API_SECRET")
    if name and key and secret:
        cloudinary.config(cloud_name=name, api_key=key,
                          api_secret=secret, secure=True)
        return True
    if os.environ.get("CLOUDINARY_URL"):
        cloudinary.config(secure=True)   # the library reads CLOUDINARY_URL itself
        return True
    return False


def store_picture_in_cloud(file):
    """Upload a picture as a private (authenticated) asset."""
    result = cloudinary.uploader.upload(
        file.stream, public_id=secrets.token_hex(16), folder="lol-chat",
        resource_type="image", type="authenticated",
        overwrite=False, unique_filename=False, use_filename=False)
    return "|".join(["cld", result["resource_type"],
                     result["public_id"], result.get("format") or ""])


def signed_cloud_url(stored, download=False):
    _, resource_type, public_id, fmt = stored.split("|", 3)
    options = {"resource_type": resource_type, "type": "authenticated",
               "sign_url": True, "secure": True}
    if fmt and resource_type != "raw":
        options["format"] = fmt
    if download and resource_type == "image":
        options["flags"] = "attachment"
    url, _ = cloudinary.utils.cloudinary_url(public_id, **options)
    return url


# ---------- Cloudflare R2 (voice notes, videos, documents) ----------

_r2 = {"checked": False, "client": None, "bucket": None}


def r2_client():
    if not _r2["checked"]:
        _r2["checked"] = True
        account = os.environ.get("R2_ACCOUNT_ID")
        key = os.environ.get("R2_ACCESS_KEY_ID")
        secret = os.environ.get("R2_SECRET_ACCESS_KEY")
        bucket = os.environ.get("R2_BUCKET")
        if boto3 and account and key and secret and bucket:
            _r2["client"] = boto3.client(
                "s3",
                endpoint_url=f"https://{account}.r2.cloudflarestorage.com",
                aws_access_key_id=key,
                aws_secret_access_key=secret,
                region_name="auto",
                config=BotoConfig(signature_version="s3v4",
                                  retries={"max_attempts": 3}),
            )
            _r2["bucket"] = bucket
    return _r2["client"]


def store_in_r2(file, chat_id, kind, ext):
    key = f"chat/{chat_id}/{secrets.token_hex(16)}.{ext}"
    r2_client().upload_fileobj(
        file.stream, _r2["bucket"], key,
        ExtraArgs={"ContentType": content_type_for(kind, ext)})
    return f"{R2_PREFIX}{key}"


def disposition(name):
    ascii_name = re.sub(r'["\\\r\n]', "", name.encode("ascii", "ignore").decode()) or "file"
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(name)}"


def signed_r2_url(stored, message, download=False):
    key = stored[len(R2_PREFIX):]
    ext = key.rsplit(".", 1)[-1].lower()
    params = {"Bucket": _r2["bucket"], "Key": key,
              "ResponseContentType": content_type_for(message.kind, ext)}
    if download or message.kind == "file":
        params["ResponseContentDisposition"] = disposition(
            message.media_name or key)
    return r2_client().generate_presigned_url(
        "get_object", Params=params, ExpiresIn=LINK_SECONDS)


# ---------- helpers ----------

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


def looks_like_video(head, ext):
    if ext in ("mp4", "m4v", "mov"):
        return head[4:8] == b"ftyp"
    if ext == "webm":
        return head.startswith(b"\x1a\x45\xdf\xa3")
    return False


def _remove_stored(stored):
    if not stored:
        return
    try:
        if stored.startswith(CLOUD_PREFIX):
            _, resource_type, public_id, _fmt = stored.split("|", 3)
            if cloud_ready():
                cloudinary.uploader.destroy(
                    public_id, resource_type=resource_type,
                    type="authenticated", invalidate=True)
        elif stored.startswith(R2_PREFIX):
            if r2_client():
                r2_client().delete_object(
                    Bucket=_r2["bucket"], Key=stored[len(R2_PREFIX):])
        else:
            os.remove(os.path.join(upload_dir(), os.path.basename(stored)))
    except OSError:
        pass
    except Exception:
        current_app.logger.warning(
            "Could not delete a stored file", exc_info=True)


def remove_media_files(messages):
    for message in messages:
        _remove_stored(message.media_url)


# ---------- uploading ----------

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
    file.stream.seek(0, os.SEEK_END)
    size = file.stream.tell()
    file.stream.seek(0)

    if wants_voice and ext in AUDIO_EXT:
        kind = "voice"
    elif ext in IMAGE_EXT:
        if not looks_like_image(head, ext):
            return failure("That image looks damaged or isn’t a real picture.")
        kind = "image"
    elif ext in VIDEO_EXT:
        if not looks_like_video(head, ext):
            return failure("That video looks damaged or isn’t a real video.")
        kind = "video"
    elif ext in DOC_EXT or ext in AUDIO_EXT:
        kind = "file"
    else:
        return failure("That file type isn’t supported.")
    if size == 0:
        return failure("That file is empty.")

    try:
        if kind == "image" and cloud_ready():
            stored = store_picture_in_cloud(file)
        elif kind != "image" and r2_client():
            stored = store_in_r2(file, chat_id, kind, ext)
        else:
            stored = f"{secrets.token_hex(16)}.{ext}"
            file.save(os.path.join(upload_dir(), stored))
    except Exception:
        current_app.logger.warning("Storing an upload failed", exc_info=True)
        return failure("Couldn’t store that file right now. Please try again.", 502)

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
        _remove_stored(stored)
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


# ---------- opening files ----------

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

    stored = message.media_url
    download = request.args.get("download") == "1"

    if stored.startswith(R2_PREFIX):
        if not r2_client():
            abort(404)
        response = redirect(signed_r2_url(stored, message, download), code=302)
        response.headers["Cache-Control"] = "private, max-age=300"
        return response

    if stored.startswith(CLOUD_PREFIX):
        if not cloud_ready():
            abort(404)
        response = redirect(signed_cloud_url(stored, download), code=302)
        response.headers["Cache-Control"] = "private, max-age=300"
        return response

    # files saved on this server's disk (local development, or older messages)
    name = os.path.basename(stored)
    path = os.path.join(upload_dir(), name)
    if not os.path.isfile(path):
        abort(404)
    ext = name.rsplit(".", 1)[-1].lower()
    inline = message.kind in ("image", "voice", "video") and not download
    response = send_file(
        path, mimetype=content_type_for(message.kind, ext),
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