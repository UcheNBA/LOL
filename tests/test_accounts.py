import re

import pytest

from lol import create_app
from lol.extensions import db, mail
from lol.models import PasswordResetToken, User


@pytest.fixture()
def app():
    app = create_app({
        "TESTING": True,
        "WTF_CSRF_ENABLED": False,
        "SQLALCHEMY_DATABASE_URI": "sqlite://",
        "MAIL_SUPPRESS_SEND": True,
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
def client(app):
    return app.test_client()


def test_register_hashes_password_and_authenticates(client, app):
    response = client.post("/auth/register", data={
        "display_name": "Riley North",
        "username": "rileynorth",
        "email": "riley@example.com",
        "phone": "",
        "password": "correct-horse-battery",
    }, follow_redirects=True)
    assert response.status_code == 200
    with app.app_context():
        user = db.session.scalar(
            db.select(User).where(User.username == "rileynorth"))
        assert user is not None
        assert user.password_hash != "correct-horse-battery"
        assert user.check_password("correct-horse-battery")
    assert b"Your account is ready" in response.data


def test_registration_rejects_invalid_username(client):
    response = client.post("/auth/register", data={
        "display_name": "Riley",
        "username": "x!",
        "email": "riley@example.com",
        "password": "correct-horse-battery",
    })
    assert response.status_code == 200
    assert b"Username must be" in response.data


def test_login_logout_and_profile_update(client):
    client.post("/auth/register", data={
        "display_name": "Riley North",
        "username": "rileynorth",
        "email": "riley@example.com",
        "password": "correct-horse-battery",
    })
    client.post("/auth/logout")
    response = client.post("/auth/login", data={
        "identifier": "riley@example.com",
        "password": "correct-horse-battery",
    }, follow_redirects=True)
    assert response.status_code == 200
    response = client.post("/auth/profile", data={
        "display_name": "Riley N.",
        "avatar_url": "https://example.com/avatar.png",
        "about": "Here for a good chat",
    }, follow_redirects=True)
    assert b"Profile updated" in response.data
    client.post("/auth/logout")
    assert client.get("/auth/profile").status_code == 302


def test_forgot_password_does_not_disclose_unknown_email(client):
    response = client.post("/auth/forgot-password",
                           data={"email": "unknown@example.com"}, follow_redirects=True)
    assert response.status_code == 200
    assert b"If an account matches that email" in response.data


def test_password_reset_email_uses_single_use_hashed_token(client, app):
    client.post("/auth/register", data={
        "display_name": "Riley North",
        "username": "rileynorth",
        "email": "riley@example.com",
        "password": "correct-horse-battery",
    })
    with mail.record_messages() as outbox:
        response = client.post("/auth/forgot-password",
                               data={"email": "riley@example.com"})
    assert response.status_code == 302
    assert len(outbox) == 1
    token = re.search(
        r"/auth/reset-password/([^\s]+)", outbox[0].body).group(1)
    assert token
    with app.app_context():
        reset = db.session.scalar(db.select(PasswordResetToken))
        assert reset is not None
        assert token not in reset.token_hash

    response = client.post(
        f"/auth/reset-password/{token}", data={"password": "another-correct-password"})
    assert response.status_code == 302
    response = client.post("/auth/login", data={
        "identifier": "rileynorth",
        "password": "another-correct-password",
    })
    assert response.status_code == 302
    response = client.get(f"/auth/reset-password/{token}")
    assert response.status_code == 302
