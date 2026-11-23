from .extensions import csrf, db, limiter, login_manager, mail
import os
import secrets

from dotenv import load_dotenv
from flask import Flask
from flask_socketio import SocketIO

load_dotenv()


socketio = SocketIO(async_mode="threading")


def create_app(test_config=None):
    app = Flask(__name__, instance_relative_config=True)
    database_url = os.environ.get("DATABASE_URL", "sqlite:///lol.sqlite")
    if database_url.startswith("postgres://"):
        database_url = database_url.replace(
            "postgres://", "postgresql+psycopg://", 1)
    elif database_url.startswith("postgresql://"):
        database_url = database_url.replace(
            "postgresql://", "postgresql+psycopg://", 1)

    engine_options = {"connect_args": {"timeout": 30}
                      } if database_url.startswith("sqlite:") else {}
    app.config.from_mapping(
        SECRET_KEY=os.environ.get("SECRET_KEY") or secrets.token_urlsafe(32),
        SQLALCHEMY_DATABASE_URI=database_url,
        SQLALCHEMY_ENGINE_OPTIONS=engine_options,
        SQLALCHEMY_TRACK_MODIFICATIONS=False,
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        SESSION_COOKIE_SECURE=os.environ.get(
            "SESSION_COOKIE_SECURE", "0") == "1",
        REMEMBER_COOKIE_HTTPONLY=True,
        REMEMBER_COOKIE_SAMESITE="Lax",
        MAIL_SERVER=os.environ.get("MAIL_SERVER"),
        MAIL_PORT=int(os.environ.get("MAIL_PORT", "587")),
        MAIL_USE_TLS=os.environ.get("MAIL_USE_TLS", "1") == "1",
        MAIL_USERNAME=os.environ.get("MAIL_USERNAME"),
        MAIL_PASSWORD=os.environ.get("MAIL_PASSWORD"),
        MAIL_DEFAULT_SENDER=os.environ.get(
            "MAIL_DEFAULT_SENDER", "LOL <noreply@example.com>"),
        PASSWORD_RESET_MINUTES=30,
        RATELIMIT_STORAGE_URI=os.environ.get(
            "RATELIMIT_STORAGE_URI", "memory://"),
    )
    if test_config:
        app.config.update(test_config)

    os.makedirs(app.instance_path, exist_ok=True)
    db.init_app(app)
    login_manager.init_app(app)
    csrf.init_app(app)
    mail.init_app(app)
    limiter.init_app(app)
    socketio.init_app(app, cors_allowed_origins=[])
    login_manager.login_view = "auth.login"
    login_manager.login_message_category = "info"

    from .models import User

    @login_manager.user_loader
    def load_user(user_id):
        return db.session.get(User, int(user_id))

    from .auth import auth_bp
    from .main import main_bp
    from .chats import chats_bp
    from .realtime import register_socket_handlers
    app.register_blueprint(auth_bp)
    app.register_blueprint(main_bp)
    app.register_blueprint(chats_bp)
    register_socket_handlers(socketio)

    with app.app_context():
        db.create_all()          # also creates the new message_hidden table
        migrate_additive_columns()

    return app


def migrate_additive_columns():
    from .models import Message, User

    database_url = str(db.engine.url)
    if database_url in {"sqlite://", "sqlite:///:memory:"}:
        return
    inspector = db.inspect(db.engine)
    dialect = db.engine.dialect.name
    timestamp_type = "TIMESTAMP WITH TIME ZONE" if dialect == "postgresql" else "DATETIME"
    additions = {
        User.__tablename__: {"last_seen_at": timestamp_type},
        Message.__tablename__: {
            "edited_at": timestamp_type,
            "deleted_at": timestamp_type,
            "reply_to_id": "INTEGER",
        },
    }
    with db.engine.begin() as connection:
        for table_name, columns in additions.items():
            existing = {column["name"]
                        for column in inspector.get_columns(table_name)}
            for column_name, column_type in columns.items():
                if column_name not in existing:
                    quoted_table = db.engine.dialect.identifier_preparer.quote(
                        table_name)
                    quoted_column = db.engine.dialect.identifier_preparer.quote(
                        column_name)
                    connection.exec_driver_sql(
                        f"ALTER TABLE {quoted_table} ADD COLUMN {quoted_column} {column_type}"
                    )