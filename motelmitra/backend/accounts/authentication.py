"""One login per user: the newest login wins.

Every login gets a new session key, stored on the user and inside the login tokens ("sid").
A token whose sid is not the user's current key belongs to an older login on another PC / phone,
so it is refused and that screen goes back to the login page with a message.
"""
from rest_framework.exceptions import AuthenticationFailed
from rest_framework_simplejwt.authentication import JWTAuthentication
from rest_framework_simplejwt.exceptions import InvalidToken
from rest_framework_simplejwt.serializers import TokenRefreshSerializer
from rest_framework_simplejwt.tokens import RefreshToken

SESSION_REPLACED = "session_replaced"
MESSAGE = "You were signed out because this user logged in on another computer or phone."


def _stale(user, sid):
    return bool(user and user.session_key) and sid != user.session_key


PLAN_OPEN_PATHS = ("/api/auth/me/", "/api/subscription/", "/api/version/")


class SingleSessionJWTAuthentication(JWTAuthentication):
    def authenticate(self, request):
        result = super().authenticate(request)
        if result and result[0].client_id:
            from rest_framework.exceptions import PermissionDenied
            from .subscription import plan_status
            user = result[0]
            st = plan_status(user.client)
            if st["status"] == "expired":
                admin_ok = user.role == "CLIENT_ADMIN" and request.path in PLAN_OPEN_PATHS
                if not admin_ok and request.path != "/api/version/":
                    raise PermissionDenied({"detail": f"The MotelMitra plan for {user.client.name} ended on "
                                                      f"{st['paid_until']:%m/%d/%Y}. Ask the motel owner to renew it.",
                                            "code": "plan_expired"})
        return result

    def get_user(self, validated_token):
        user = super().get_user(validated_token)
        if _stale(user, validated_token.get("sid")):
            raise AuthenticationFailed({"detail": MESSAGE, "code": SESSION_REPLACED})
        return user


class SingleSessionRefreshSerializer(TokenRefreshSerializer):
    def validate(self, attrs):
        from .models import User
        try:
            token = RefreshToken(attrs["refresh"])
        except Exception:
            return super().validate(attrs)   # expired / broken: the usual error
        user = User.objects.filter(pk=token.get("user_id")).first()
        if _stale(user, token.get("sid")):
            raise InvalidToken({"detail": MESSAGE, "code": SESSION_REPLACED})
        return super().validate(attrs)
