import pytest

from lol import create_app, socketio
from lol.extensions import db
from lol.models import Chat, ChatMember, Message, MessageStatus, User
from lol.models import Reaction
from lol.presence import is_online


@pytest.fixture()
def app():
    app = create_app({
        "TESTING": True,
        "WTF_CSRF_ENABLED": False,
        "SQLALCHEMY_DATABASE_URI": "sqlite://",
        "RATELIMIT_ENABLED": False,
        "SECRET_KEY": "test-secret",
    })
    with app.app_context():
        db.drop_all()
        db.create_all()
    yield app
    with app.app_context():
        db.session.remove()
        db.drop_all()


@pytest.fixture()
def users(app):
    with app.app_context():
        first = User(username="first_user",
                     email="first@example.com", display_name="First User")
        first.set_password("correct-horse-battery")
        second = User(username="second_user",
                      email="second@example.com", display_name="Second User")
        second.set_password("correct-horse-battery")
        stranger = User(username="stranger",
                        email="stranger@example.com", display_name="Stranger")
        stranger.set_password("correct-horse-battery")
        db.session.add_all([first, second, stranger])
        db.session.commit()
        return first.id, second.id, stranger.id


def signed_in_client(app, username):
    client = app.test_client()
    response = client.post(
        "/auth/login", data={"identifier": username, "password": "correct-horse-battery"})
    assert response.status_code == 302, response.data.decode()
    with client.session_transaction() as session:
        assert session.get("_user_id"), response.headers.get("Set-Cookie")
    return client


def test_search_start_and_reuse_direct_chat(app, users):
    first_id, second_id, _ = users
    client = signed_in_client(app, "first_user")
    response = client.get("/api/users?q=second")
    assert response.status_code == 200
    assert response.json["users"][0]["id"] == second_id

    first_chat = client.post(
        "/api/chats", json={"user_id": second_id}).json["chat_id"]
    second_chat = client.post(
        "/api/chats", json={"user_id": second_id}).json["chat_id"]
    assert first_chat == second_chat
    with app.app_context():
        chat = db.session.get(Chat, first_chat)
        assert chat.type == "direct"
        assert {member.user_id for member in chat.members} == {
            first_id, second_id}


def test_chat_messages_are_hidden_from_nonmembers(app, users):
    first_id, second_id, stranger_id = users
    client = signed_in_client(app, "first_user")
    chat_id = client.post(
        "/api/chats", json={"user_id": second_id}).json["chat_id"]
    with app.app_context():
        message = Message(chat_id=chat_id, sender_id=first_id,
                          body="Private hello", client_id="seed-message")
        db.session.add(message)
        db.session.commit()
    stranger = signed_in_client(app, "stranger")
    with stranger.session_transaction() as session:
        assert session.get("_user_id") == str(stranger_id)
    assert stranger.get(f"/api/chats/{chat_id}/messages").status_code == 404
    assert stranger.get(f"/api/chats/{chat_id}").status_code == 404
    with app.app_context():
        assert db.session.get(User, stranger_id) is not None


def test_socket_message_is_saved_and_client_id_is_idempotent(app, users):
    first_id, second_id, _ = users
    client = signed_in_client(app, "first_user")
    chat_id = client.post(
        "/api/chats", json={"user_id": second_id}).json["chat_id"]
    socket_client = socketio.test_client(app, flask_test_client=client)
    assert socket_client.is_connected()
    joined = socket_client.emit(
        "chat:join", {"chat_id": chat_id}, callback=True)
    assert joined["ok"]
    payload = {"chat_id": chat_id, "body": "Hello in real time",
               "client_id": "stable-client-message-1"}
    first_result = socket_client.emit("message:send", payload, callback=True)
    second_result = socket_client.emit("message:send", payload, callback=True)
    assert first_result["ok"] and second_result["ok"]
    assert first_result["message"]["id"] == second_result["message"]["id"]
    assert first_result["message"]["sender_id"] == first_id
    with app.app_context():
        assert db.session.scalar(db.select(db.func.count(Message.id))) == 1
    socket_client.disconnect()


def test_socket_rejects_nonmember_send(app, users):
    _, second_id, _ = users
    first_client = signed_in_client(app, "first_user")
    chat_id = first_client.post(
        "/api/chats", json={"user_id": second_id}).json["chat_id"]
    stranger_client = signed_in_client(app, "stranger")
    socket_client = socketio.test_client(
        app, flask_test_client=stranger_client)
    joined = socket_client.emit(
        "chat:join", {"chat_id": chat_id}, callback=True)
    assert not joined["ok"]
    result = socket_client.emit("message:send", {
        "chat_id": chat_id,
        "body": "Not allowed",
        "client_id": "unauthorized-message",
    }, callback=True)
    assert not result["ok"]
    socket_client.disconnect()


def test_joining_chat_marks_pending_messages_read(app, users):
    first_id, second_id, _ = users
    first_client = signed_in_client(app, "first_user")
    chat_id = first_client.post(
        "/api/chats", json={"user_id": second_id}).json["chat_id"]
    with app.app_context():
        message = Message(
            chat_id=chat_id,
            sender_id=second_id,
            body="Read this when you open the chat",
            client_id="pending-read-check",
        )
        db.session.add(message)
        db.session.flush()
        status = MessageStatus(message_id=message.id, user_id=first_id)
        db.session.add(status)
        db.session.commit()
        message_id = message.id

    socket_client = socketio.test_client(app, flask_test_client=first_client)
    joined = socket_client.emit(
        "chat:join", {"chat_id": chat_id}, callback=True)
    assert joined["ok"]
    with app.app_context():
        status = db.session.scalar(db.select(MessageStatus).where(
            MessageStatus.message_id == message_id))
        member = db.session.scalar(db.select(ChatMember).where(
            ChatMember.chat_id == chat_id, ChatMember.user_id == first_id
        ))
        assert status.delivered_at is not None
        assert status.read_at is not None
        assert member.last_read_at is not None
    socket_client.disconnect()


def test_message_history_paginates_older_messages_in_order(app, users):
    first_id, second_id, _ = users
    client = signed_in_client(app, "first_user")
    chat_id = client.post(
        "/api/chats", json={"user_id": second_id}).json["chat_id"]
    with app.app_context():
        db.session.add_all([
            Message(
                chat_id=chat_id,
                sender_id=first_id if index % 2 == 0 else second_id,
                body=f"History message {index}",
                client_id=f"history-page-{index}",
            )
            for index in range(1, 36)
        ])
        db.session.commit()

    newest = client.get(f"/api/chats/{chat_id}/messages").json
    assert len(newest["messages"]) == 30
    assert newest["has_more"] is True
    assert newest["messages"][0]["body"] == "History message 6"
    assert newest["messages"][-1]["body"] == "History message 35"

    older = client.get(
        f"/api/chats/{chat_id}/messages?before={newest['messages'][0]['id']}"
    ).json
    assert len(older["messages"]) == 5
    assert older["has_more"] is False
    assert [message["body"] for message in older["messages"]] == [
        f"History message {index}" for index in range(1, 6)
    ]


def test_message_edit_is_limited_to_sender(app, users):
    first_id, second_id, _ = users
    owner_client = signed_in_client(app, "first_user")
    chat_id = owner_client.post(
        "/api/chats", json={"user_id": second_id}).json["chat_id"]
    socket_owner = socketio.test_client(app, flask_test_client=owner_client)
    sent = socket_owner.emit("message:send", {
        "chat_id": chat_id,
        "body": "Original text",
        "client_id": "editable-message",
    }, callback=True)
    message_id = sent["message"]["id"]

    stranger_socket = socketio.test_client(
        app, flask_test_client=signed_in_client(app, "stranger"))
    denied = stranger_socket.emit("message:edit", {
        "message_id": message_id,
        "body": "Changed by someone else",
    }, callback=True)
    assert not denied["ok"]

    edited = socket_owner.emit("message:edit", {
        "message_id": message_id,
        "body": "Updated text",
    }, callback=True)
    assert edited["ok"]
    assert edited["message"]["body"] == "Updated text"
    assert edited["message"]["edited"] is True
    with app.app_context():
        message = db.session.get(Message, message_id)
        assert message.sender_id == first_id
        assert message.edited_at is not None
    stranger_socket.disconnect()
    socket_owner.disconnect()


def test_reactions_toggle_and_aggregate(app, users):
    _, second_id, _ = users
    client = signed_in_client(app, "first_user")
    chat_id = client.post(
        "/api/chats", json={"user_id": second_id}).json["chat_id"]
    socket_client = socketio.test_client(app, flask_test_client=client)
    sent = socket_client.emit("message:send", {
        "chat_id": chat_id,
        "body": "React here",
        "client_id": "reactable-message",
    }, callback=True)
    message_id = sent["message"]["id"]

    first = socket_client.emit("message:react", {
        "message_id": message_id, "emoji": "❤️",
    }, callback=True)
    assert first["ok"]
    assert first["reactions"] == [{"emoji": "❤️", "count": 1, "reacted": True}]
    second = socket_client.emit("message:react", {
        "message_id": message_id, "emoji": "❤️",
    }, callback=True)
    assert second["ok"]
    assert second["reactions"] == []
    with app.app_context():
        assert db.session.scalar(db.select(db.func.count(Reaction.id))) == 0
    socket_client.disconnect()


def test_disconnect_records_last_seen(app, users):
    user_id, _, _ = users
    client = signed_in_client(app, "first_user")
    socket_client = socketio.test_client(app, flask_test_client=client)
    assert is_online(user_id)
    socket_client.disconnect()
    assert not is_online(user_id)
    with app.app_context():
        user = db.session.get(User, user_id)
        assert user.last_seen_at is not None
