import datetime
from decimal import Decimal

from django.conf import settings
from django.db import models
from django.db.models import Sum

from accounts.models import Client


class RoomType(models.Model):
    """King, Queen, Double, Suite, Jacuzzi, Handicap ... with a default nightly rate."""

    client = models.ForeignKey(Client, on_delete=models.CASCADE, related_name="room_types")
    name = models.CharField(max_length=50)
    default_rate = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    description = models.CharField(max_length=255, blank=True)
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ["name"]
        unique_together = ("client", "name")

    def __str__(self):
        return self.name


class Room(models.Model):
    client = models.ForeignKey(Client, on_delete=models.CASCADE, related_name="rooms")
    number = models.CharField(max_length=20)
    room_type = models.ForeignKey(RoomType, on_delete=models.PROTECT, related_name="rooms")
    floor = models.CharField(max_length=20, blank=True)
    notes = models.CharField(max_length=255, blank=True)
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ["number"]
        unique_together = ("client", "number")

    def __str__(self):
        return f"{self.number} ({self.room_type.name})"


class Guest(models.Model):
    """A person. One guest can have many stays (repeat visits)."""

    client = models.ForeignKey(Client, on_delete=models.CASCADE, related_name="guests")
    name = models.CharField(max_length=150)
    address = models.CharField(max_length=255, blank=True)
    city = models.CharField(max_length=100, blank=True)
    state = models.CharField(max_length=50, blank=True)
    zip_code = models.CharField(max_length=20, blank=True)
    phone = models.CharField(max_length=30, blank=True, db_index=True)
    car = models.CharField(max_length=100, blank=True)
    license_plate = models.CharField(max_length=30, blank=True, db_index=True)
    do_not_rent = models.BooleanField(default=False)
    # v2: license card image
    license_card = models.FileField(upload_to="license_cards/", blank=True, null=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["name"]

    def __str__(self):
        return self.name


class Stay(models.Model):
    """One guest check-in (the 'guest onboarding' record)."""

    CHECKED_IN = "CHECKED_IN"
    CHECKED_OUT = "CHECKED_OUT"
    STATUS_CHOICES = [(CHECKED_IN, "Checked In"), (CHECKED_OUT, "Checked Out")]

    client = models.ForeignKey(Client, on_delete=models.CASCADE, related_name="stays")
    guest = models.ForeignKey(Guest, on_delete=models.PROTECT, related_name="stays")
    room = models.ForeignKey(Room, on_delete=models.PROTECT, related_name="stays")

    check_in_date = models.DateField()
    check_in_time = models.TimeField()
    check_out_date = models.DateField()
    check_out_time = models.TimeField(default=datetime.time(11, 0))
    num_guests = models.PositiveSmallIntegerField(default=1)
    num_days = models.PositiveSmallIntegerField(default=1)

    rate = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    total_amount = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    # set when the clerk edits the balance at check-in: + extra charge, - discount
    adjustment = models.DecimalField(max_digits=10, decimal_places=2, default=0)

    clerk = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name="stays"
    )
    comments = models.TextField(blank=True)
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default=CHECKED_IN)
    checked_out_at = models.DateTimeField(null=True, blank=True)

    # soft delete (client admin can recover from "Deleted Guests")
    is_deleted = models.BooleanField(default=False)
    deleted_at = models.DateTimeField(null=True, blank=True)
    deleted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL,
        related_name="deleted_stays",
    )

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-check_in_date", "-check_in_time"]

    def save(self, *args, **kwargs):
        days = (self.check_out_date - self.check_in_date).days
        self.num_days = max(days, 1)
        self.total_amount = (Decimal(self.rate) * self.num_days + Decimal(self.adjustment or 0)).quantize(Decimal("0.01"))
        super().save(*args, **kwargs)

    @property
    def amount_paid(self):
        return self.payments.aggregate(s=Sum("amount"))["s"] or Decimal("0")

    @property
    def balance(self):
        return self.total_amount - self.amount_paid

    def __str__(self):
        return f"{self.guest.name} / Room {self.room.number} / {self.check_in_date}"


class Payment(models.Model):
    CASH = "CASH"
    CREDIT = "CREDIT"
    METHOD_CHOICES = [(CASH, "Cash"), (CREDIT, "Credit")]

    stay = models.ForeignKey(Stay, on_delete=models.CASCADE, related_name="payments")
    amount = models.DecimalField(max_digits=10, decimal_places=2)
    method = models.CharField(max_length=10, choices=METHOD_CHOICES)
    paid_at = models.DateTimeField()
    clerk = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name="payments"
    )
    is_initial = models.BooleanField(default=False, help_text="Collected at check-in")
    notes = models.CharField(max_length=255, blank=True)

    class Meta:
        ordering = ["paid_at"]

    def __str__(self):
        return f"{self.method} {self.amount} for stay {self.stay_id}"


class Note(models.Model):
    """A note for maintenance / housekeeping, written by front desk staff for a date."""

    client = models.ForeignKey(Client, on_delete=models.CASCADE, related_name="maintenance_notes")
    date = models.DateField(db_index=True)
    room = models.ForeignKey(Room, null=True, blank=True, on_delete=models.SET_NULL, related_name="maintenance_notes")
    text = models.TextField()
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name="maintenance_notes"
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["date", "created_at"]

    def __str__(self):
        return f"{self.date} {self.room or 'General'}: {self.text[:40]}"
