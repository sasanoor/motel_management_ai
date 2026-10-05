from rest_framework import status, viewsets
from rest_framework.decorators import action, api_view, permission_classes
from rest_framework.exceptions import ValidationError
from django.conf import settings
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework_simplejwt.views import TokenObtainPairView

from .models import Client, User
from .permissions import IsClientAdmin, IsClientStaff, IsSuperAdmin
from .serializers import (
    ClientOnboardSerializer, ClientSerializer, LoginSerializer, MotelSettingsSerializer, UserSerializer,
)


class LoginView(TokenObtainPairView):
    serializer_class = LoginSerializer


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
    return Response({"version": settings.APP_VERSION})
