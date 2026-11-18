import hashlib
import re
import secrets
from datetime import timedelta

from email_validator import EmailNotValidError, validate_email
from flask import Blueprint, current_app, flash, redirect, render_template, request, url_for
from flask_login import current_user, login_user, logout_user, login_required
from flask_mail import Message as MailMessage
from sqlalchemy import or_, select

from .extensions import db, limiter, mail
from .models import PasswordResetToken, User, utcnow

auth_bp = Blueprint("auth", __name__, url_prefix="/auth")
USERNAME_PATTERN = re.compile(r"^[a-zA-Z0-9_]{3,32}$")


def normalize_email(value):
    if not value:
        return None
    return validate_email(value.strip(), check_deliverability=False).normalized.lower()


def normalize_phone(value):
    if not value:
        return None
    cleaned = re.sub(r"[\s().-]", "", value)
    if not re.fullmatch(r"\+?[0-9]{7,15}", cleaned):
        raise ValueError(
            "Enter a valid phone number, including country code when needed.")
    return cleaned


@auth_bp.route("/register", methods=["GET", "POST"])
@limiter.limit("5 per minute")
def register():
    if current_user.is_authenticated:
        return redirect(url_for("main.index"))
    if request.method == "POST":
        username = request.form.get("username", "").strip().lower()
        display_name = request.form.get("display_name", "").strip()
        email_input = request.form.get("email", "").strip()
        phone_input = request.form.get("phone", "").strip()
        password = request.form.get("password", "")
        error = None
        try:
            email = normalize_email(email_input)
            phone = normalize_phone(phone_input)
        except (EmailNotValidError, ValueError) as exc:
            error = str(exc)
            email, phone = None, None
        if error is None and not USERNAME_PATTERN.fullmatch(username):
            error = "Username must be 3-32 letters, numbers, or underscores."
        elif error is None and not display_name:
            error = "Enter your name."
        elif error is None and len(display_name) > 80:
            error = "Name must be 80 characters or fewer."
        elif error is None and not (email or phone):
            error = "Enter an email address or phone number."
        elif error is None and len(password) < 10:
            error = "Password must be at least 10 characters."

        if error is None:
            identity_checks = [User.username == username]
            if email:
                identity_checks.append(User.email == email)
            if phone:
                identity_checks.append(User.phone == phone)
            existing = db.session.scalar(
                select(User).where(or_(*identity_checks)))
            if existing:
                error = "That username, email, or phone number is already in use."
        if error:
            flash(error, "error")
        else:
            user = User(username=username, email=email,
                        phone=phone, display_name=display_name)
            user.set_password(password)
            db.session.add(user)
            db.session.commit()
            login_user(user)
            flash("Your account is ready.", "success")
            return redirect(url_for("main.index"))
    return render_template("auth/register.html")


@auth_bp.route("/login", methods=["GET", "POST"])
@limiter.limit("5 per minute")
def login():
    if current_user.is_authenticated:
        return redirect(url_for("main.index"))
    if request.method == "POST":
        identifier = request.form.get("identifier", "").strip().lower()
        password = request.form.get("password", "")
        identity_checks = [User.username ==
                           identifier, User.email == identifier]
        try:
            phone_identifier = normalize_phone(identifier)
            if phone_identifier:
                identity_checks.append(User.phone == phone_identifier)
        except ValueError:
            pass
        user = db.session.scalar(select(User).where(or_(*identity_checks)))
        if user and user.check_password(password):
            login_user(user, remember=request.form.get("remember") == "on")
            next_url = request.args.get("next", "")
            return redirect(next_url if next_url.startswith("/") and not next_url.startswith("//") else url_for("main.index"))
        flash("Check your sign-in details and try again.", "error")
    return render_template("auth/login.html")


@auth_bp.post("/logout")
@login_required
def logout():
    logout_user()
    flash("You are signed out.", "info")
    return redirect(url_for("main.index"))


@auth_bp.route("/forgot-password", methods=["GET", "POST"])
@limiter.limit("3 per hour")
def forgot_password():
    if request.method == "POST":
        email = request.form.get("email", "").strip().lower()
        user = db.session.scalar(select(User).where(User.email == email))
        if user:
            raw_token = secrets.token_urlsafe(32)
            reset = PasswordResetToken(
                user_id=user.id,
                token_hash=hashlib.sha256(raw_token.encode()).hexdigest(),
                expires_at=utcnow() +
                timedelta(
                    minutes=current_app.config["PASSWORD_RESET_MINUTES"]),
            )
            db.session.add(reset)
            db.session.commit()
            reset_url = url_for("auth.reset_password",
                                token=raw_token, _external=True)
            try:
                mail.send(MailMessage("Reset your LOL password", recipients=[
                          user.email], body=f"Use this link within 30 minutes to reset your password:\n\n{reset_url}"))
            except Exception:
                current_app.logger.exception(
                    "Unable to send password reset email")
        flash("If an account matches that email, a reset link is on its way.", "info")
        return redirect(url_for("auth.login"))
    return render_template("auth/forgot_password.html")


@auth_bp.route("/reset-password/<token>", methods=["GET", "POST"])
def reset_password(token):
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    reset = db.session.scalar(select(PasswordResetToken).where(
        PasswordResetToken.token_hash == token_hash))
    now = utcnow()
    if not reset or reset.used_at or reset.expires_at.replace(tzinfo=now.tzinfo) <= now:
        flash("That reset link is invalid or expired.", "error")
        return redirect(url_for("auth.forgot_password"))
    if request.method == "POST":
        password = request.form.get("password", "")
        if len(password) < 10:
            flash("Password must be at least 10 characters.", "error")
        else:
            reset.user.set_password(password)
            reset.used_at = now
            db.session.commit()
            flash(
                "Your password has been updated. Sign in with your new password.", "success")
            return redirect(url_for("auth.login"))
    return render_template("auth/reset_password.html")


@auth_bp.route("/profile", methods=["GET", "POST"])
@login_required
def profile():
    if request.method == "POST":
        display_name = request.form.get("display_name", "").strip()
        avatar_url = request.form.get("avatar_url", "").strip()
        about = request.form.get("about", "").strip()
        if not display_name or len(display_name) > 80:
            flash("Name is required and must be 80 characters or fewer.", "error")
        elif len(avatar_url) > 2048 or (avatar_url and not avatar_url.startswith(("https://", "http://"))):
            flash("Photo must be an HTTP or HTTPS URL.", "error")
        elif len(about) > 280:
            flash("About text must be 280 characters or fewer.", "error")
        else:
            current_user.display_name = display_name
            current_user.avatar_url = avatar_url or None
            current_user.about = about
            db.session.commit()
            flash("Profile updated.", "success")
            return redirect(url_for("auth.profile"))
    return render_template("auth/profile.html")
