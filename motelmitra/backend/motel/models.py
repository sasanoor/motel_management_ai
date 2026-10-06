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

    # Housekeeping status (for the room when nobody is in it). Checkout makes it DIRTY.
    READY = "READY"
    DIRTY = "DIRTY"
    CLEANING = "CLEANING"
    OUT_OF_ORDER = "OUT_OF_ORDER"
    HK_CHOICES = [(READY, "Ready"), (DIRTY, "Dirty"), (CLEANING, "Cleaning"), (OUT_OF_ORDER, "Out of order")]
    hk_status = models.CharField(max_length=14, choices=HK_CHOICES, default=READY)
    hk_note = models.CharField(max_length=255, blank=True)   # out of order reason
    hk_updated_at = models.DateTimeField(null=True, blank=True)
    hk_updated_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL,
                                      related_name="+")

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
    dl_number = models.CharField("Driving licence number", max_length=40, blank=True, db_index=True)
    do_not_rent = models.BooleanField(default=False)
    dnr_reason = models.CharField(max_length=255, blank=True)
    dnr_marked_at = models.DateTimeField(null=True, blank=True)
    dnr_marked_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="dnr_marked"
    )
    # v2: license card image
    license_card = models.FileField(upload_to="license_cards/", blank=True, null=True)
    # Guest Directory delete (admin only). Soft delete: hidden from the directory, check-in lookups and
    # the DNR check; the guest's stays and payments stay in every report. Admin can recover.
    is_deleted = models.BooleanField(default=False, db_index=True)
    deleted_at = models.DateTimeField(null=True, blank=True)
    deleted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="guests_deleted"
    )
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
        self.dl_number = " ".join((self.dl_number or "").upper().split())
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
    early_checkin_fee = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    damage_fee = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    # early checkout: room charge for the nights actually used, and the booking as it was before
    room_charge_override = models.DecimalField(max_digits=10, decimal_places=2, null=True, blank=True)
    # Add stay with a different rent type or rate (e.g. a daily guest adds 1 week at the weekly rate):
    # those nights sit at the end of the stay and are charged here, not at `rate`.
    extra_stay_nights = models.PositiveIntegerField(default=0)
    extra_stay_charge = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    # "Check in again" with the old balance added: + on the new stay (brought in), - on the old stay (moved out)
    balance_carried = models.DecimalField(max_digits=10, decimal_places=2, default=0)
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
        base_out = self.check_out_date - datetime.timedelta(days=self.extra_stay_nights or 0)
        if base_out <= self.check_in_date:
            base_out = self.check_in_date + datetime.timedelta(days=1)
        self.periods = self.calc_periods(self.rate_type, self.check_in_date, base_out, self.periods)
        self.total_amount = (
            self.room_charge + self.charges_total + Decimal(self.adjustment or 0) + Decimal(self.balance_carried or 0)
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
        return (Decimal(self.rate) * self.periods + Decimal(self.extra_stay_charge or 0)).quantize(Decimal("0.01"))

    @property
    def charges_total(self):
        """Pets + extra persons + card fee + late fee."""
        return sum((Decimal(x or 0) for x in (self.pet_fee, self.extra_person_fee, self.card_fee, self.late_fee,
                                                self.early_checkin_fee, self.damage_fee)),
                   Decimal("0"))

    @property
    def period_label(self):
        return {self.DAILY: "night", self.WEEKLY: "week", self.MONTHLY: "month"}[self.rate_type]

    @property
    def nightly_value(self):
        """Room revenue per night, used for occupancy / ADR on weekly and monthly stays."""
        own = self.total_amount - Decimal(self.balance_carried or 0)
        return (own / max(self.num_days, 1)).quantize(Decimal("0.01"))

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


# ------------------------------------------------------------------ photos (DL and room damage)
class PhotoSession(models.Model):
    """
    "Use phone" QR code: lets a phone on the motel WiFi send photos to one check-in / checkout
    without logging in. The token works for 10 minutes.
    """

    token = models.CharField(max_length=40, unique=True)
    client = models.ForeignKey(Client, on_delete=models.CASCADE, related_name="photo_sessions")
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name="+")
    kind = models.CharField(max_length=12)
    stay = models.ForeignKey("Stay", null=True, blank=True, on_delete=models.CASCADE, related_name="+")
    expires_at = models.DateTimeField()
    created_at = models.DateTimeField(auto_now_add=True)


class Photo(models.Model):
    """
    DL photo (front / back) or room damage photo.
    Stored privately under media/<check-in date>/Room-<number>/<YYYYMMDD-HHMM>_<room>_<KIND>_<n>.jpg
    (DNR-only guests: media/DNR/..., not yet saved check-ins: media/pending/...).
    """

    DL_FRONT = "DL_FRONT"
    DL_BACK = "DL_BACK"
    DAMAGE = "DAMAGE"
    ISSUE = "ISSUE"
    KINDS = [(DL_FRONT, "DL front"), (DL_BACK, "DL back"), (DAMAGE, "Room damage"), (ISSUE, "Room problem")]

    client = models.ForeignKey(Client, on_delete=models.CASCADE, related_name="photos")
    guest = models.ForeignKey(Guest, null=True, blank=True, on_delete=models.SET_NULL, related_name="photos")
    stay = models.ForeignKey("Stay", null=True, blank=True, on_delete=models.SET_NULL, related_name="photos")
    session = models.ForeignKey(PhotoSession, null=True, blank=True, on_delete=models.SET_NULL, related_name="photos")
    issue = models.ForeignKey("RoomIssue", null=True, blank=True, on_delete=models.SET_NULL, related_name="photos")
    kind = models.CharField(max_length=12, choices=KINDS)
    file = models.FileField(max_length=255)
    via = models.CharField(max_length=10, blank=True)  # PHONE / WEBCAM / FILE
    uploaded_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL,
                                    related_name="photos")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["created_at"]

    def __str__(self):
        return self.file.name


def photo_target(photo):
    """Folder and file name for a photo, from its stay (or DNR guest) and time taken."""
    from django.utils import timezone as tz
    when = tz.localtime(photo.created_at or tz.now())
    stamp = when.strftime("%Y%m%d-%H%M")
    if photo.issue_id:
        # room problems: media/Problems/Room-<n>/<stamp>_<room>_PROBLEM-<issue id>_<n>.jpg
        room = photo.issue.room.number
        safe_room = "".join(ch for ch in str(room) if ch.isalnum() or ch in "-_") or "X"
        others = Photo.objects.filter(issue_id=photo.issue_id).exclude(pk=photo.pk)
        n = 1 + sum(1 for o in others if o.created_at and photo.created_at and o.created_at <= photo.created_at)
        return f"Problems/Room-{safe_room}/{stamp}_{safe_room}_PROBLEM-{photo.issue_id}_{n}.jpg"
    if photo.stay_id:
        st = photo.stay
        folder = f"{st.check_in_date:%Y-%m-%d}/Room-{st.room.number}"
        room = st.room.number
    elif photo.guest_id:
        folder, room = "DNR", "DNR"
    else:
        folder, room = "pending", "NEW"
    label = "DL" if photo.kind in (Photo.DL_FRONT, Photo.DL_BACK) else "DAMAGE"
    if photo.kind == Photo.DL_FRONT:
        n = 1
    elif photo.kind == Photo.DL_BACK:
        n = 2
    else:   # damage photos are numbered 1, 2, 3 ... within the stay
        others = Photo.objects.filter(stay_id=photo.stay_id, kind=Photo.DAMAGE).exclude(pk=photo.pk) if photo.stay_id else []
        n = 1 + sum(1 for o in others if o.created_at and photo.created_at and o.created_at <= photo.created_at)
    safe_room = "".join(ch for ch in str(room) if ch.isalnum() or ch in "-_") or "X"
    return f"{folder}/{stamp}_{safe_room}_{label}_{n}.jpg"


def place_photo(photo):
    """Move the file to where it belongs (after it is linked to a stay, or the room changes)."""
    import os
    from django.core.files.storage import default_storage
    target = photo_target(photo)
    if photo.file.name == target:
        return
    base, ext = os.path.splitext(target)
    i = 2
    while default_storage.exists(target):
        target = f"{base}-{i}{ext}"
        i += 1
    src = default_storage.path(photo.file.name)
    dst = default_storage.path(target)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    if os.path.exists(src):
        os.replace(src, dst)
    photo.file.name = target
    photo.save(update_fields=["file"])


def copy_photo(photo, **changes):
    """Copy a photo (and its file) for another stay, e.g. a returning guest's DL."""
    import os
    import shutil
    from django.core.files.storage import default_storage
    new = Photo(client=photo.client, guest=photo.guest, kind=photo.kind, via="REUSED",
                uploaded_by=photo.uploaded_by, **changes)
    new.file.name = photo.file.name
    new.save()
    tmp = f"pending/copy-{new.pk}.jpg"
    src = default_storage.path(photo.file.name)
    dst = default_storage.path(tmp)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    if os.path.exists(src):
        shutil.copyfile(src, dst)
    new.file.name = tmp
    new.save(update_fields=["file"])
    place_photo(new)
    return new


def delete_photo_file(photo):
    from django.core.files.storage import default_storage
    if photo.file.name and default_storage.exists(photo.file.name):
        default_storage.delete(photo.file.name)


def attach_photos(stay, photo_ids, reuse_dl=False):
    """
    Link photos taken on the check-in form (they wait in media/pending/) to the saved stay,
    and, for a returning guest with no new DL photo, copy their last DL photo into this stay.
    """
    ids = [int(i) for i in (photo_ids or [])]
    if ids:
        for ph in Photo.objects.filter(client=stay.client, id__in=ids, stay__isnull=True):
            ph.stay = stay
            if ph.kind in (Photo.DL_FRONT, Photo.DL_BACK):
                ph.guest = stay.guest
            ph.save(update_fields=["stay", "guest"])
            place_photo(ph)
    if reuse_dl:
        have = set(stay.photos.filter(kind__in=[Photo.DL_FRONT, Photo.DL_BACK]).values_list("kind", flat=True))
        for kind in (Photo.DL_FRONT, Photo.DL_BACK):
            if kind in have:
                continue
            last = (Photo.objects.filter(client=stay.client, guest=stay.guest, kind=kind)
                    .exclude(stay=stay).order_by("-created_at").first())
            if last:
                copy_photo(last, stay=stay)


class CustomReport(models.Model):
    """A report a motel builds itself on Reports -> Custom reports (source, columns, filters, grouping)."""

    client = models.ForeignKey(Client, on_delete=models.CASCADE, related_name="custom_reports")
    name = models.CharField(max_length=100)
    config = models.JSONField(default=dict)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name="custom_reports")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["name"]
        constraints = [models.UniqueConstraint(fields=["client", "name"], name="unique_custom_report_name")]

    def __str__(self):
        return self.name


class RoomStatusLog(models.Model):
    """Every housekeeping change: status changes, stay-over service, and renting a room that was not ready
    (who did it, when). Kept for the record."""

    STATUS = "STATUS"
    SERVICE = "SERVICE"        # stay-over room serviced (to_status DONE / DECLINED)
    OVERRIDE = "OVERRIDE"      # checked a guest into a room that was not ready / out of order
    ACTIONS = [(STATUS, "Status"), (SERVICE, "Service"), (OVERRIDE, "Rented while not ready")]

    client = models.ForeignKey(Client, on_delete=models.CASCADE, related_name="room_logs")
    room = models.ForeignKey(Room, on_delete=models.CASCADE, related_name="status_logs")
    action = models.CharField(max_length=10, choices=ACTIONS)
    from_status = models.CharField(max_length=14, blank=True)
    to_status = models.CharField(max_length=14, blank=True)
    note = models.CharField(max_length=255, blank=True)
    business_date = models.DateField(db_index=True)
    stay = models.ForeignKey("Stay", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name="+")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]


class RoomIssue(models.Model):
    """A problem in a room (leak, broken AC ...), reported by anyone and tracked until fixed."""

    OPEN = "OPEN"
    IN_PROGRESS = "IN_PROGRESS"
    FIXED = "FIXED"
    STATUSES = [(OPEN, "Open"), (IN_PROGRESS, "In progress"), (FIXED, "Fixed")]
    CATEGORIES = [("PLUMBING", "Plumbing"), ("ELECTRICAL", "Electrical"), ("AC_HEAT", "AC / Heat"),
                  ("TV_WIFI", "TV / WiFi"), ("FURNITURE", "Furniture"), ("PESTS", "Pests"),
                  ("CLEANLINESS", "Cleanliness"), ("OTHER", "Other")]
    PRIORITIES = [("LOW", "Low"), ("NORMAL", "Normal"), ("URGENT", "Urgent")]

    client = models.ForeignKey(Client, on_delete=models.CASCADE, related_name="room_issues")
    room = models.ForeignKey(Room, on_delete=models.CASCADE, related_name="issues")
    category = models.CharField(max_length=12, choices=CATEGORIES, default="OTHER")
    priority = models.CharField(max_length=8, choices=PRIORITIES, default="NORMAL")
    description = models.TextField()
    status = models.CharField(max_length=12, choices=STATUSES, default=OPEN)
    made_out_of_order = models.BooleanField(default=False)
    reported_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name="+")
    fixed_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    fixed_at = models.DateTimeField(null=True, blank=True)
    history = models.JSONField(default=list, blank=True)   # [{at, by, status, note}]
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]
