import datetime

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

    # Charges & fees (defaults pre-filled at check-in; clerk can change per guest)
    card_fee_percent = models.DecimalField(max_digits=5, decimal_places=2, default=0,
                                           help_text="Card payment fee, % of the card amount")
    pet_fee = models.DecimalField(max_digits=10, decimal_places=2, default=0, help_text="Per pet, per stay")
    extra_person_fee = models.DecimalField(max_digits=10, decimal_places=2, default=0,
                                           help_text="Per extra person, per night")
    included_guests = models.PositiveSmallIntegerField(default=2, help_text="Guests included in the room rate")
    late_fee = models.DecimalField(max_digits=10, decimal_places=2, default=0, help_text="Late checkout fee")
    early_checkin_fee = models.DecimalField(max_digits=10, decimal_places=2, default=0, help_text="Early check-in fee")
    # WiFi printer / scanner for DL photos
    scanner_address = models.CharField(max_length=120, blank=True, help_text="Printer IP for direct scan (eSCL / AirScan)")
    scanner_area = models.CharField(max_length=8, default="DL", help_text="DL = card size in the top-left corner, PAGE = full page")
    scan_folder = models.CharField(max_length=255, blank=True, help_text="Folder on this PC where the printer saves scans")
    # Business day: changes automatically at this time, or earlier when the front desk runs Night Audit.
    day_change_time = models.TimeField(default=datetime.time(11, 0),
                                       help_text="Business day changes automatically at this time")

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
    # One login at a time: a new login replaces this key, and tokens from the older login stop working.
    session_key = models.CharField(max_length=40, blank=True, default="")

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


class Plan(models.Model):
    """A MotelMitra subscription plan sold by the super admin (Monthly, 3 months, 1 year ...)."""

    name = models.CharField(max_length=60)
    months = models.PositiveSmallIntegerField(default=1)
    price = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ["months", "name"]

    def __str__(self):
        return self.name


class Subscription(models.Model):
    """One paid period for a motel. Plan name / months / price are copied so later price changes do not rewrite history."""

    client = models.ForeignKey(Client, on_delete=models.CASCADE, related_name="subscriptions")
    plan = models.ForeignKey(Plan, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    plan_name = models.CharField(max_length=60)
    months = models.PositiveSmallIntegerField(default=1)
    price = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    start_date = models.DateField()
    end_date = models.DateField()   # last day the motel can use MotelMitra
    notes = models.CharField(max_length=255, blank=True)
    created_by = models.ForeignKey("User", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-end_date", "-id"]
