from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.permissions import BasePermission

from .models import Client, User


class IsSuperAdmin(BasePermission):
    def has_permission(self, request, view):
        return bool(request.user and request.user.is_authenticated and request.user.is_super_admin)


class IsClientAdmin(BasePermission):
    def has_permission(self, request, view):
        u = request.user
        return bool(u and u.is_authenticated and u.role == User.CLIENT_ADMIN and u.client_id)


class IsClientStaff(BasePermission):
    """Client admin or client user, attached to an active motel."""

    def has_permission(self, request, view):
        u = request.user
        return bool(
            u and u.is_authenticated
            and u.role in (User.CLIENT_ADMIN, User.CLIENT_USER)
            and u.client_id and u.client.is_active
        )


class IsClientStaffOrSuperAdmin(BasePermission):
    def has_permission(self, request, view):
        u = request.user
        if not (u and u.is_authenticated):
            return False
        if u.is_super_admin:
            return True
        return IsClientStaff().has_permission(request, view)


def get_request_client(request):
    """
    Which motel a request works on.
    Client staff: always their own motel.
    Super admin: must pass ?client=<id> (read-only reporting use).
    """
    user = request.user
    if user.is_super_admin:
        client_id = request.query_params.get("client")
        if not client_id:
            raise ValidationError({"client": "Select a client."})
        try:
            return Client.objects.get(pk=client_id)
        except Client.DoesNotExist:
            raise ValidationError({"client": "Client not found."})
    if not user.client_id:
        raise PermissionDenied("User is not attached to a motel.")
    return user.client
