"""
MotelMitra settings.

All environment specific values are read from backend/.env
(copy .env.example to .env and edit).
"""
import os
from datetime import timedelta
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent

# App version: APP_VERSION in the .env file next to start_app.bat (shipped with every update).
# The screens show it and compare it with their own copy, so an update is never half applied.
from dotenv import dotenv_values  # noqa: E402
APP_VERSION = (dotenv_values(BASE_DIR.parent / ".env").get("APP_VERSION") or "dev").strip()
load_dotenv(BASE_DIR / ".env")

# HOST_ON_WIFI=yes / no (backend/.env): start_app serves on the WiFi or on this PC only.
HOST_ON_WIFI = os.getenv("HOST_ON_WIFI", "yes").strip().lower() not in ("no", "n", "false", "0", "off")
# GRID_SCROLL_BUTTONS=yes / no (backend/.env): Netflix-style < > buttons on wide grids. Each motel decides.
GRID_SCROLL_BUTTONS = os.getenv("GRID_SCROLL_BUTTONS", "yes").strip().lower() not in ("no", "n", "false", "0", "off")

def _secret_key():
    """SECRET_KEY signs every login token. Never use a key that is shipped with the code:
    if backend/.env has no real key, make a random one once and keep it in backend/.secret_key."""
    key = (os.getenv("SECRET_KEY") or "").strip()
    if key and "change-me" not in key and "insecure" not in key:
        return key
    path = BASE_DIR / ".secret_key"
    try:
        if path.exists() and path.read_text().strip():
            return path.read_text().strip()
        import secrets
        key = secrets.token_urlsafe(50)
        path.write_text(key)
        return key
    except OSError:
        import secrets
        return secrets.token_urlsafe(50)


SECRET_KEY = _secret_key()
# DEBUG shows program code and settings on an error page. Off unless DEBUG=True is set in backend/.env.
DEBUG = os.getenv("DEBUG", "False").strip().lower() in ("true", "1", "yes")
ALLOWED_HOSTS = os.getenv("ALLOWED_HOSTS", "127.0.0.1,localhost").split(",")

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    # third party
    "rest_framework",
    "corsheaders",
    # local
    "accounts",
    "motel",
]

MIDDLEWARE = [
    "corsheaders.middleware.CorsMiddleware",
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "config.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "config.wsgi.application"

# ---------------------------------------------------------------- Database
# DB_ENGINE=mysql (default) or sqlite (quick local testing only)
if os.getenv("DB_ENGINE", "mysql") == "sqlite":
    DATABASES = {
        "default": {
            "ENGINE": "django.db.backends.sqlite3",
            "NAME": BASE_DIR / "db.sqlite3",
        }
    }
else:
    DATABASES = {
        "default": {
            "ENGINE": "django.db.backends.mysql",
            "NAME": os.getenv("DB_NAME", "motelmitra"),
            "USER": os.getenv("DB_USER", "motelmitra_user"),
            "PASSWORD": os.getenv("DB_PASSWORD", ""),
            "HOST": os.getenv("DB_HOST", "127.0.0.1"),
            "PORT": os.getenv("DB_PORT", "3306"),
            "OPTIONS": {"charset": "utf8mb4"},
        }
    }

AUTH_USER_MODEL = "accounts.User"

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator",
     "OPTIONS": {"min_length": 6}},
]

LANGUAGE_CODE = "en-us"
TIME_ZONE = os.getenv("TIME_ZONE", "America/Chicago")
USE_I18N = True
USE_TZ = True

STATIC_URL = "static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
MEDIA_URL = "media/"
MEDIA_ROOT = BASE_DIR / "media"

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# ---------------------------------------------------------------- API
REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": (
        "accounts.authentication.SingleSessionJWTAuthentication",   # one login per user, newest wins
    ),
    "DEFAULT_PERMISSION_CLASSES": (
        "rest_framework.permissions.IsAuthenticated",
    ),
}

SIMPLE_JWT = {
    "ACCESS_TOKEN_LIFETIME": timedelta(hours=12),
    "REFRESH_TOKEN_LIFETIME": timedelta(days=7),
}

CORS_ALLOWED_ORIGINS = os.getenv(
    "CORS_ALLOWED_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173"
).split(",")
