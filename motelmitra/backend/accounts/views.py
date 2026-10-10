from rest_framework import status, viewsets
from rest_framework.decorators import action, api_view, permission_classes
from rest_framework.exceptions import ValidationError
from django.conf import settings
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework_simplejwt.views import TokenObtainPairView, TokenRefreshView

from .authentication import SingleSessionRefreshSerializer

from .models import Client, Plan, Subscription, User
from .subscription import end_for, plan_status
from .permissions import IsClientAdmin, IsClientStaff, IsSuperAdmin
from .serializers import (
    PlanSerializer, SubscriptionSerializer,
    ClientOnboardSerializer, ClientSerializer, LoginSerializer, MotelSettingsSerializer, UserSerializer,
)


LOGIN_MAX_FAILS = 10          # wrong passwords allowed per user name ...
LOGIN_LOCK_SECONDS = 15 * 60  # ... in this window, then that user name is paused


class LoginView(TokenObtainPairView):
    """Login with a password-guessing guard: after 10 wrong passwords for one user name, that name is
    paused for 15 minutes. Only failed tries count (the screens reach the server through one proxy,
    so a limit by IP would lock out the whole front desk)."""
    serializer_class = LoginSerializer

    def post(self, request, *args, **kwargs):
        from django.core.cache import cache
        name = str(request.data.get("username") or "").strip().lower()
        key = f"login-fails:{name}"
        if name and cache.get(key, 0) >= LOGIN_MAX_FAILS:
            return Response({"detail": "Too many wrong passwords. Try again in 15 minutes, or ask the admin to reset the password."},
                            status=status.HTTP_429_TOO_MANY_REQUESTS)
        try:
            resp = super().post(request, *args, **kwargs)
        except Exception:
            # wrong user name / password raise here (simplejwt); count the failed try, then answer as usual
            if name:
                cache.set(key, cache.get(key, 0) + 1, LOGIN_LOCK_SECONDS)
            raise
        if name and resp.status_code == 200:
            cache.delete(key)
        return resp


class SingleSessionRefreshView(TokenRefreshView):
    """Refresh refuses tokens from an older login of the same user (one login per user)."""
    serializer_class = SingleSessionRefreshSerializer


@api_view(["GET"])
def me(request):
    return Response(UserSerializer(request.user).data)


class ClientViewSet(viewsets.ModelViewSet):
    """Super admin: onboard and manage motels."""

    permission_classes = [IsSuperAdmin]
    queryset = Client.objects.all()

    def get_serializer_class(self):
        return ClientOnboardSerializer if self.action == "create" else ClientSerializer

    def destroy(self, request, *args, **kwargs):
        # Never hard delete a motel; deactivate instead.
        client = self.get_object()
        client.is_active = False
        client.save()
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=True, methods=["get"])
    def users(self, request, pk=None):
        client = self.get_object()
        return Response(UserSerializer(client.users.all().order_by("username"), many=True).data)

    @action(detail=True, methods=["get", "post"])
    def subscriptions(self, request, pk=None):
        """Plans of one motel. POST {plan, start_date?, price?, notes}: start defaults to the day after the
        paid-up date (renewal) or today (new / expired)."""
        import datetime
        from decimal import Decimal, InvalidOperation
        client = self.get_object()
        if request.method == "POST":
            plan = Plan.objects.filter(pk=request.data.get("plan")).first()
            if not plan:
                raise ValidationError({"plan": "Pick a plan."})
            st = plan_status(client)
            raw = request.data.get("start_date")
            if raw:
                try:
                    start = datetime.date.fromisoformat(str(raw))
                except ValueError:
                    raise ValidationError({"start_date": "Use a valid date."})
            elif st["status"] in ("active", "expiring"):
                start = st["paid_until"] + datetime.timedelta(days=1)
            else:
                start = st.get("today") or datetime.date.today()
            try:
                price = Decimal(str(request.data.get("price"))) if request.data.get("price") not in (None, "") else plan.price
            except InvalidOperation:
                raise ValidationError({"price": "Enter a number."})
            if price < 0 or price > Decimal("999999"):
                raise ValidationError({"price": "Enter a price from 0 to 999999."})
            Subscription.objects.create(client=client, plan=plan, plan_name=plan.name, months=plan.months, price=price,
                                        start_date=start, end_date=end_for(start, plan.months),
                                        notes=(request.data.get("notes") or "").strip()[:255], created_by=request.user)
        return Response({"plan": plan_status(client),
                         "history": SubscriptionSerializer(client.subscriptions.all(), many=True).data})

    @action(detail=True, methods=["delete"], url_path=r"subscriptions/(?P<sub_id>\d+)")
    def remove_subscription(self, request, pk=None, sub_id=None):
        """Undo a plan added by mistake."""
        client = self.get_object()
        client.subscriptions.filter(pk=sub_id).delete()
        return Response({"plan": plan_status(client),
                         "history": SubscriptionSerializer(client.subscriptions.all(), many=True).data})


class PlanViewSet(viewsets.ModelViewSet):
    """Super admin: plan names, length and price."""
    permission_classes = [IsSuperAdmin]
    serializer_class = PlanSerializer
    queryset = Plan.objects.all()


@api_view(["GET"])
def my_subscription(request):
    """The motel's own plan (client admin's My Plan screen, warning popup, expired screen)."""
    client = request.user.client
    if client is None:
        return Response({"plan": {"status": "none"}, "history": []})
    history = client.subscriptions.all() if request.user.role == User.CLIENT_ADMIN else client.subscriptions.none()
    return Response({"plan": plan_status(client), "history": SubscriptionSerializer(history, many=True).data})


class UserViewSet(viewsets.ModelViewSet):
    """Client admin: onboard and manage users of their own motel."""

    permission_classes = [IsClientAdmin]
    serializer_class = UserSerializer

    def get_queryset(self):
        return User.objects.filter(client=self.request.user.client).order_by("username")

    def perform_create(self, serializer):
        serializer.save(client=self.request.user.client)

    def perform_update(self, serializer):
        if serializer.instance == self.request.user:
            if serializer.validated_data.get("is_active") is False:
                raise ValidationError("You cannot deactivate yourself.")
            if serializer.validated_data.get("role", User.CLIENT_ADMIN) != User.CLIENT_ADMIN:
                raise ValidationError("You cannot change your own role.")
        serializer.save()

    def destroy(self, request, *args, **kwargs):
        user = self.get_object()
        if user == request.user:
            raise ValidationError("You cannot deactivate yourself.")
        user.is_active = False
        user.save()
        return Response(status=status.HTTP_204_NO_CONTENT)


@api_view(["GET", "PATCH"])
@permission_classes([IsClientStaff])
def motel_settings(request):
    """Charges & fees for the logged-in user's motel. Everyone on staff can read; only the admin can change."""
    client = request.user.client
    if request.method == "PATCH":
        if request.user.role != User.CLIENT_ADMIN:
            return Response({"detail": "Only the client admin can change charges."}, status=status.HTTP_403_FORBIDDEN)
        ser = MotelSettingsSerializer(client, data=request.data, partial=True)
        ser.is_valid(raise_exception=True)
        ser.save()
        return Response(ser.data)
    return Response(MotelSettingsSerializer(client).data)


@api_view(["GET"])
@permission_classes([AllowAny])
def version(request):
    """Running server version; start_app.bat and the screens use it to spot an old server after an update."""
    return Response({"version": settings.APP_VERSION, "wifi": settings.HOST_ON_WIFI,
                     "grid_scroll_buttons": settings.GRID_SCROLL_BUTTONS})
