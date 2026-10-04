from django.contrib.auth.models import AbstractUser
from django.db import models


class Client(models.Model):
    """A motel (tenant) onboarded by the super admin."""

    name = models.CharField(max_length=150)
    address = models.CharField(max_length=255, blank=True)
    city = models.CharField(max_length=100, blank=True)
    state = models.CharField(max_length=50, blank=True)
    zip_code = models.CharField(max_length=20, blank=True)
    phone = models.CharField(max_length=30, blank=True)
    email = models.EmailField(blank=True)
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["name"]

    def __str__(self):
        return self.name


class User(AbstractUser):
    SUPER_ADMIN = "SUPER_ADMIN"
    CLIENT_ADMIN = "CLIENT_ADMIN"
    CLIENT_USER = "CLIENT_USER"
    MAINTENANCE = "MAINTENANCE"
    ROLE_CHOICES = [
        (SUPER_ADMIN, "Super Admin"),
        (CLIENT_ADMIN, "Client Admin"),
        (CLIENT_USER, "Client User"),
        (MAINTENANCE, "Maintenance"),
    ]

    role = models.CharField(max_length=20, choices=ROLE_CHOICES, default=CLIENT_USER)
    client = models.ForeignKey(
        Client, null=True, blank=True, on_delete=models.CASCADE, related_name="users"
    )
    phone = models.CharField(max_length=30, blank=True)

    def save(self, *args, **kwargs):
        # Anyone created with `createsuperuser` becomes the platform super admin.
        if self.is_superuser:
            self.role = self.SUPER_ADMIN
            self.client = None
        super().save(*args, **kwargs)

    @property
    def is_super_admin(self):
        return self.role == self.SUPER_ADMIN

    @property
    def is_client_admin(self):
        return self.role == self.CLIENT_ADMIN

    def __str__(self):
        return self.get_full_name() or self.username
