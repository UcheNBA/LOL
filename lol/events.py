from . import socketio
from .chat_service import message_payload
from .presence import sockets_for


def broadcast_message(message, event="message:new"):
    """Send one message to everyone in its chat room."""
    socketio.emit(event, message_payload(message, message.sender_id or 0),
                  to=f"chat:{message.chat_id}")


def refresh_chat_lists(user_ids, chat_id):
    """Ask these people's browsers to reload their chat list."""
    for user_id in set(user_ids):
        socketio.emit("chat:activity", {"chat_id": chat_id}, to=f"user:{user_id}")


def join_chat_room(user_id, chat_id):
    """Put all of a user's open tabs into a chat's live room."""
    for sid in sockets_for(user_id):
        socketio.server.enter_room(sid, f"chat:{chat_id}", namespace="/")


def leave_chat_room(user_id, chat_id):
    for sid in sockets_for(user_id):
        socketio.server.leave_room(sid, f"chat:{chat_id}", namespace="/")