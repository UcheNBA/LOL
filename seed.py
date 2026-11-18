import getpass
import os
from datetime import timedelta

from sqlalchemy import select

from lol import create_app
from lol.extensions import db
from lol.models import Chat, ChatMember, Message, MessageStatus, User, utcnow

app = create_app()


def get_or_create_user(username, email, display_name, about, password):
    user = db.session.scalar(select(User).where(User.username == username))
    if user:
        return user
    user = User(
        username=username,
        email=email,
        display_name=display_name,
        about=about,
    )
    user.set_password(password)
    db.session.add(user)
    db.session.flush()
    return user


def main():
    password = os.environ.get("DEMO_PASSWORD") or getpass.getpass(
        "Choose a password for the demo accounts (10+ characters): ")
    if len(password) < 10:
        raise SystemExit("DEMO_PASSWORD must contain at least 10 characters.")

    with app.app_context():
        maya = get_or_create_user("maya_chen", "maya@example.test",
                                  "Maya Chen", "Probably finding a new coffee spot", password)
        theo = get_or_create_user(
            "theo_park", "theo@example.test", "Theo Park", "Weekend trail enthusiast", password)
        alex = get_or_create_user("alex_rivera", "alex@example.test",
                                  "Alex Rivera", "Making playlists for everything", password)

        direct_chat = db.session.scalar(select(Chat).join(ChatMember).where(
            Chat.type == "direct", ChatMember.user_id == maya.id,
        ).group_by(Chat.id).having(db.func.count(ChatMember.user_id) == 2))
        if not direct_chat:
            direct_chat = Chat(type="direct", creator_id=maya.id)
            db.session.add(direct_chat)
            db.session.flush()
            db.session.add_all([
                ChatMember(chat_id=direct_chat.id,
                           user_id=maya.id, role="member"),
                ChatMember(chat_id=direct_chat.id,
                           user_id=theo.id, role="member"),
            ])
            db.session.flush()
            now = utcnow()
            db.session.scalar(select(ChatMember).where(
                ChatMember.chat_id == direct_chat.id, ChatMember.user_id == maya.id
            )).last_read_at = now
            db.session.scalar(select(ChatMember).where(
                ChatMember.chat_id == direct_chat.id, ChatMember.user_id == theo.id
            )).last_read_at = now
            messages = [
                Message(chat_id=direct_chat.id, sender_id=theo.id, body="Coffee after work? I found a place with those cardamom buns you like.",
                        client_id="demo-maya-theo-1", created_at=now - timedelta(minutes=14)),
                Message(chat_id=direct_chat.id, sender_id=maya.id, body="You had me at cardamom buns. What time?",
                        client_id="demo-maya-theo-2", created_at=now - timedelta(minutes=11)),
                Message(chat_id=direct_chat.id, sender_id=theo.id, body="6:15? I'll grab us a table by the window.",
                        client_id="demo-maya-theo-3", created_at=now - timedelta(minutes=7)),
                Message(chat_id=direct_chat.id, sender_id=maya.id, body="Perfect. See you there ☕",
                        client_id="demo-maya-theo-4", created_at=now - timedelta(minutes=4)),
            ]
            db.session.add_all(messages)
            db.session.flush()
            db.session.add_all([
                MessageStatus(message_id=message.id,
                              user_id=theo.id, delivered_at=now, read_at=now)
                for message in messages if message.sender_id == maya.id
            ])
            db.session.add_all([
                MessageStatus(message_id=message.id,
                              user_id=maya.id, delivered_at=now, read_at=now)
                for message in messages if message.sender_id == theo.id
            ])
            direct_chat.updated_at = now - timedelta(minutes=4)

        db.session.commit()
        print("Demo accounts are ready:")
        print("  maya_chen / maya@example.test")
        print("  theo_park / theo@example.test")
        print("  alex_rivera / alex@example.test")
        print("All three accounts use the password you entered.")


if __name__ == "__main__":
    main()
