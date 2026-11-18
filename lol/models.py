from datetime import datetime, timezone

from flask_login import UserMixin
from werkzeug.security import check_password_hash, generate_password_hash

from .extensions import db


def utcnow():
    return datetime.now(timezone.utc)


class User(UserMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(32), unique=True,
                         nullable=False, index=True)
    email = db.Column(db.String(254), unique=True, index=True)
    phone = db.Column(db.String(32), unique=True, index=True)
    password_hash = db.Column(db.String(255), nullable=False)
    display_name = db.Column(db.String(80), nullable=False)
    avatar_url = db.Column(db.String(2048))
    about = db.Column(db.String(280), nullable=False, default="")
    created_at = db.Column(db.DateTime(timezone=True),
                           nullable=False, default=utcnow)
    updated_at = db.Column(db.DateTime(timezone=True),
                           nullable=False, default=utcnow, onupdate=utcnow)

    def set_password(self, password):
        self.password_hash = generate_password_hash(password)

    def check_password(self, password):
        return check_password_hash(self.password_hash, password)


class Contact(db.Model):
    __tablename__ = "contacts"
    id = db.Column(db.Integer, primary_key=True)
    owner_id = db.Column(db.Integer, db.ForeignKey(
        "user.id", ondelete="CASCADE"), nullable=False)
    contact_id = db.Column(db.Integer, db.ForeignKey(
        "user.id", ondelete="CASCADE"), nullable=False)
    created_at = db.Column(db.DateTime(timezone=True),
                           nullable=False, default=utcnow)
    __table_args__ = (db.UniqueConstraint(
        "owner_id", "contact_id", name="uq_contact_owner_target"),)


class Chat(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    type = db.Column(db.String(16), nullable=False, default="direct")
    name = db.Column(db.String(80))
    avatar_url = db.Column(db.String(2048))
    creator_id = db.Column(db.Integer, db.ForeignKey(
        "user.id", ondelete="SET NULL"))
    created_at = db.Column(db.DateTime(timezone=True),
                           nullable=False, default=utcnow)
    updated_at = db.Column(db.DateTime(timezone=True),
                           nullable=False, default=utcnow, index=True)
    members = db.relationship(
        "ChatMember", back_populates="chat", cascade="all, delete-orphan")
    messages = db.relationship(
        "Message", back_populates="chat", cascade="all, delete-orphan")


class ChatMember(db.Model):
    __tablename__ = "chat_members"
    id = db.Column(db.Integer, primary_key=True)
    chat_id = db.Column(db.Integer, db.ForeignKey(
        "chat.id", ondelete="CASCADE"), nullable=False)
    user_id = db.Column(db.Integer, db.ForeignKey(
        "user.id", ondelete="CASCADE"), nullable=False)
    role = db.Column(db.String(16), nullable=False, default="member")
    joined_at = db.Column(db.DateTime(timezone=True),
                          nullable=False, default=utcnow)
    last_read_at = db.Column(db.DateTime(timezone=True))
    chat = db.relationship("Chat", back_populates="members")
    user = db.relationship("User")
    __table_args__ = (
        db.UniqueConstraint("chat_id", "user_id", name="uq_chat_member"),
        db.Index("ix_chat_members_user_chat", "user_id", "chat_id"),
    )


class Message(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    client_id = db.Column(db.String(64), nullable=False, unique=True)
    chat_id = db.Column(db.Integer, db.ForeignKey(
        "chat.id", ondelete="CASCADE"), nullable=False)
    sender_id = db.Column(db.Integer, db.ForeignKey(
        "user.id", ondelete="SET NULL"))
    body = db.Column(db.String(4000), nullable=False)
    media_url = db.Column(db.String(2048))
    reply_to_id = db.Column(db.Integer, db.ForeignKey(
        "message.id", ondelete="SET NULL"))
    created_at = db.Column(db.DateTime(timezone=True),
                           nullable=False, default=utcnow)
    deleted_at = db.Column(db.DateTime(timezone=True))
    chat = db.relationship("Chat", back_populates="messages")
    sender = db.relationship("User")
    statuses = db.relationship(
        "MessageStatus", back_populates="message", cascade="all, delete-orphan")
    __table_args__ = (
        db.Index("ix_messages_chat_created", "chat_id", "created_at"),)


class MessageStatus(db.Model):
    __tablename__ = "message_status"
    id = db.Column(db.Integer, primary_key=True)
    message_id = db.Column(db.Integer, db.ForeignKey(
        "message.id", ondelete="CASCADE"), nullable=False)
    user_id = db.Column(db.Integer, db.ForeignKey(
        "user.id", ondelete="CASCADE"), nullable=False)
    delivered_at = db.Column(db.DateTime(timezone=True))
    read_at = db.Column(db.DateTime(timezone=True))
    message = db.relationship("Message", back_populates="statuses")
    user = db.relationship("User")
    __table_args__ = (
        db.UniqueConstraint("message_id", "user_id",
                            name="uq_message_status_recipient"),
        db.Index("ix_message_status_message_user", "message_id", "user_id"),
    )


class PasswordResetToken(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey(
        "user.id", ondelete="CASCADE"), nullable=False)
    token_hash = db.Column(db.String(64), nullable=False, unique=True)
    expires_at = db.Column(db.DateTime(timezone=True), nullable=False)
    used_at = db.Column(db.DateTime(timezone=True))
    user = db.relationship("User")


class Reaction(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    message_id = db.Column(db.Integer, db.ForeignKey(
        "message.id", ondelete="CASCADE"), nullable=False)
    user_id = db.Column(db.Integer, db.ForeignKey(
        "user.id", ondelete="CASCADE"), nullable=False)
    emoji = db.Column(db.String(32), nullable=False)
    created_at = db.Column(db.DateTime(timezone=True),
                           nullable=False, default=utcnow)
    __table_args__ = (db.UniqueConstraint(
        "message_id", "user_id", "emoji", name="uq_message_reaction"),)


class Block(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    blocker_id = db.Column(db.Integer, db.ForeignKey(
        "user.id", ondelete="CASCADE"), nullable=False)
    blocked_id = db.Column(db.Integer, db.ForeignKey(
        "user.id", ondelete="CASCADE"), nullable=False)
    created_at = db.Column(db.DateTime(timezone=True),
                           nullable=False, default=utcnow)
    __table_args__ = (db.UniqueConstraint(
        "blocker_id", "blocked_id", name="uq_user_block"),)


class PushSubscription(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey(
        "user.id", ondelete="CASCADE"), nullable=False)
    endpoint = db.Column(db.String(2048), nullable=False, unique=True)
    p256dh = db.Column(db.String(255), nullable=False)
    auth = db.Column(db.String(255), nullable=False)
    created_at = db.Column(db.DateTime(timezone=True),
                           nullable=False, default=utcnow)
    __table_args__ = (db.Index("ix_push_subscriptions_user", "user_id"),)
