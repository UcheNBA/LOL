from flask import Blueprint, render_template
from flask_login import current_user
from sqlalchemy import select

from .chat_service import chat_payload
from .extensions import db
from .models import Chat, ChatMember

main_bp = Blueprint("main", __name__)


@main_bp.get("/")
def index():
    if not current_user.is_authenticated:
        return render_template("index.html")
    chats = db.session.scalars(
        select(Chat).join(ChatMember).where(ChatMember.user_id ==
                                            current_user.id).order_by(Chat.updated_at.desc())
    ).all()
    return render_template("chat.html", chats=[chat_payload(chat, current_user.id) for chat in chats])
