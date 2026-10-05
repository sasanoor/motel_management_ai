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
    default_rate = models.DecimalField(max_digits=10, decimal_places=2, default=0)  # daily
    weekly_rate = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    monthly_rate = models.DecimalField(max_digits=10, decimal_places=2, default=0)
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
    # Full name, kept in step with the parts below (search, lists and reports use it)
    name = models.CharField(max_length=150, blank=True)
    first_name = models.CharField(max_length=60, blank=True)
    middle_name = models.CharField(max_length=60, blank=True)
    last_name = models.CharField(max_length=60, blank=True)
    address = models.CharField(max_length=255, blank=True)
    city = models.CharField(max_length=100, blank=True)
    state = models.CharField(max_length=50, blank=True)
    zip_code = models.CharField(max_length=20, blank=True)
    phone = models.CharField(max_length=30, blank=True, db_index=True)
    car = models.CharField(max_length=100, blank=True)
    license_plate = models.CharField(max_length=30, blank=True, db_index=True)
    do_not_rent = models.BooleanField(default=False)
    dnr_reason = models.CharField(max_length=255, blank=True)
    dnr_marked_at = models.DateTimeField(null=True, blank=True)
    dnr_marked_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="dnr_marked"
    )
    # v2: license card image
    license_card = models.FileField(upload_to="license_cards/", blank=True, null=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["name"]

    def save(self, *args, **kwargs):
        from django.utils import timezone
        # name parts win; an old-style full name only is split into parts
        parts = [x.strip() for x in (self.first_name, self.middle_name, self.last_name)]
        if any(parts):
            self.first_name, self.middle_name, self.last_name = parts
            self.name = join_name(*parts)
        elif self.name:
            self.name = " ".join(self.name.split())
            self.first_name, self.middle_name, self.last_name = split_name(self.name)
        if self.do_not_rent and not self.dnr_marked_at:
            self.dnr_marked_at = timezone.now()
        if not self.do_not_rent:
            self.dnr_marked_at = None
            self.dnr_marked_by = None
        super().save(*args, **kwargs)

    def __str__(self):
        return self.name


def split_name(full):
    """'John Q Public' -> ('John', 'Q', 'Public'); 'Cher' -> ('Cher', '', '')."""
    words = (full or "").split()
    if not words:
        return "", "", ""
    if len(words) == 1:
        return words[0], "", ""
    return words[0], " ".join(words[1:-1]), words[-1]


def join_name(first, middle, last):
    return " ".join(x.strip() for x in (first, middle, last) if x and x.strip())


def months_between(start, end):
    """Whole months from start to end, rounded up (Oct 4 -> Nov 4 = 1, Oct 4 -> Nov 10 = 2)."""
    months = (end.year - start.year) * 12 + (end.month - start.month)
    if end.day > start.day:
        months += 1
    return max(months, 1)


class Stay(models.Model):
    """One guest check-in (the 'guest onboarding' record)."""

    DAILY = "DAILY"
    WEEKLY = "WEEKLY"
    MONTHLY = "MONTHLY"
    RATE_TYPE_CHOICES = [(DAILY, "Daily"), (WEEKLY, "Weekly"), (MONTHLY, "Monthly")]

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

    rate_type = models.CharField(max_length=10, choices=RATE_TYPE_CHOICES, default=DAILY)
    # rate is per night / per week / per month depending on rate_type
    rate = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    # number of nights / weeks / months charged
    periods = models.PositiveSmallIntegerField(default=1)
    total_amount = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    # set when the clerk edits the balance at check-in: + extra charge, - discount
    adjustment = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    # extra charges collected at check-in (stored as totals for the stay)
    pets = models.PositiveSmallIntegerField(default=0)
    pet_fee = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    extra_persons = models.PositiveSmallIntegerField(default=0)
    extra_person_fee = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    card_fee = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    late_fee = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    # early checkout: room charge for the nights actually used, and the booking as it was before
    room_charge_override = models.DecimalField(max_digits=10, decimal_places=2, null=True, blank=True)
    early_snapshot = models.JSONField(null=True, blank=True)

    clerk = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name="stays"
    )
    comments = models.TextField(blank=True)
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default=CHECKED_IN)
    checked_out_at = models.DateTimeField(null=True, blank=True)
    # set when this stay was created with "Check out & check in again" (same guest staying on)
    renewed_from = models.ForeignKey(
        "self", null=True, blank=True, on_delete=models.SET_NULL, related_name="renewals"
    )

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
        self.periods = self.calc_periods(self.rate_type, self.check_in_date, self.check_out_date, self.periods)
        self.total_amount = (
            self.room_charge + self.charges_total + Decimal(self.adjustment or 0)
        ).quantize(Decimal("0.01"))
        super().save(*args, **kwargs)

    @classmethod
    def calc_periods(cls, rate_type, check_in, check_out, given=None):
        """Nights for daily. Weeks / months: the clerk's number, or worked out from the dates."""
        nights = max((check_out - check_in).days, 1)
        if rate_type == cls.WEEKLY:
            return max(int(given or 0), 1) if given else max(-(-nights // 7), 1)
        if rate_type == cls.MONTHLY:
            return max(int(given or 0), 1) if given else months_between(check_in, check_out)
        return nights

    @property
    def room_charge(self):
        if self.room_charge_override is not None:
            return Decimal(self.room_charge_override).quantize(Decimal("0.01"))
        return (Decimal(self.rate) * self.periods).quantize(Decimal("0.01"))

    @property
    def charges_total(self):
        """Pets + extra persons + card fee + late fee."""
        return sum((Decimal(x or 0) for x in (self.pet_fee, self.extra_person_fee, self.card_fee, self.late_fee)),
                   Decimal("0"))

    @property
    def period_label(self):
        return {self.DAILY: "night", self.WEEKLY: "week", self.MONTHLY: "month"}[self.rate_type]

    @property
    def nightly_value(self):
        """Room revenue per night, used for occupancy / ADR on weekly and monthly stays."""
        return (self.total_amount / max(self.num_days, 1)).quantize(Decimal("0.01"))

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
    PAYMENT = "PAYMENT"
    REFUND = "REFUND"
    kind = models.CharField(max_length=10, choices=[(PAYMENT, "Payment"), (REFUND, "Refund")], default=PAYMENT)
    notes = models.CharField(max_length=255, blank=True)
    # The business day the money was received on (reports and the room sheet count it on this day)
    business_date = models.DateField(null=True, blank=True, db_index=True)

    class Meta:
        ordering = ["paid_at"]

    def save(self, *args, **kwargs):
        if not self.business_date:
            from .business import business_date
            self.business_date = business_date(self.stay.client)
        super().save(*args, **kwargs)

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


class DayClose(models.Model):
    """Night Audit: the front desk closed this business day; the next day starts right away."""

    client = models.ForeignKey(Client, on_delete=models.CASCADE, related_name="day_closes")
    date = models.DateField()
    closed_at = models.DateTimeField()
    closed_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL,
                                  related_name="day_closes")
    summary = models.JSONField(default=dict, blank=True)

    class Meta:
        ordering = ["-date"]
        unique_together = [("client", "date")]

    def __str__(self):
        return f"{self.client} closed {self.date}"


class Expense(models.Model):
    """Money paid out by the front desk (supplies, repairs ...). Counted on its business day."""

    CASH = "CASH"
    CREDIT = "CREDIT"
    client = models.ForeignKey(Client, on_delete=models.CASCADE, related_name="expenses")
    business_date = models.DateField(db_index=True)
    amount = models.DecimalField(max_digits=10, decimal_places=2)
    method = models.CharField(max_length=10, choices=[(CASH, "Cash"), (CREDIT, "Card")], default=CASH)
    description = models.CharField(max_length=255)
    clerk = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name="expenses")
    created_at = models.DateTimeField(auto_now_add=True)
    # deleted expenses are kept for the record
    is_deleted = models.BooleanField(default=False)
    deleted_at = models.DateTimeField(null=True, blank=True)
    deleted_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL,
                                   related_name="expenses_deleted")

    class Meta:
        ordering = ["business_date", "created_at"]

    def __str__(self):
        return f"{self.business_date} {self.method} {self.amount} {self.description}"
