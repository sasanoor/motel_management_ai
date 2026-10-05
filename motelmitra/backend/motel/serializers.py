from decimal import Decimal

from django.db import transaction
from django.utils import timezone
from rest_framework import serializers

from .models import Expense, Guest, Note, Payment, Room, RoomType, Stay, join_name, split_name

ZERO = Decimal("0.00")


class RoomTypeSerializer(serializers.ModelSerializer):
    room_count = serializers.SerializerMethodField()

    class Meta:
        model = RoomType
        fields = ["id", "name", "default_rate", "weekly_rate", "monthly_rate", "description", "is_active", "room_count"]

    def get_room_count(self, obj):
        return obj.rooms.filter(is_active=True).count()

    def validate_name(self, value):
        client = self.context["request"].user.client
        qs = RoomType.objects.filter(client=client, name__iexact=value)
        if self.instance:
            qs = qs.exclude(pk=self.instance.pk)
        if qs.exists():
            raise serializers.ValidationError("This room type already exists.")
        return value


class RoomSerializer(serializers.ModelSerializer):
    room_type_name = serializers.CharField(source="room_type.name", read_only=True)
    default_rate = serializers.DecimalField(
        source="room_type.default_rate", max_digits=10, decimal_places=2, read_only=True
    )
    weekly_rate = serializers.DecimalField(
        source="room_type.weekly_rate", max_digits=10, decimal_places=2, read_only=True
    )
    monthly_rate = serializers.DecimalField(
        source="room_type.monthly_rate", max_digits=10, decimal_places=2, read_only=True
    )

    class Meta:
        model = Room
        fields = ["id", "number", "room_type", "room_type_name", "default_rate", "weekly_rate", "monthly_rate",
                  "floor", "notes", "is_active"]

    def validate_room_type(self, value):
        if value.client_id != self.context["request"].user.client_id:
            raise serializers.ValidationError("Invalid room type.")
        return value

    def validate_number(self, value):
        client = self.context["request"].user.client
        qs = Room.objects.filter(client=client, number__iexact=value)
        if self.instance:
            qs = qs.exclude(pk=self.instance.pk)
        if qs.exists():
            raise serializers.ValidationError("This room number already exists.")
        return value


class GuestSerializer(serializers.ModelSerializer):
    stay_count = serializers.SerializerMethodField()
    last_stay = serializers.SerializerMethodField()
    dnr_marked_by_name = serializers.SerializerMethodField()

    class Meta:
        model = Guest
        fields = [
            "id", "name", "first_name", "middle_name", "last_name", "address", "city", "state", "zip_code", "phone", "car",
            "license_plate", "do_not_rent", "dnr_reason", "dnr_marked_at", "dnr_marked_by_name",
            "stay_count", "last_stay", "created_at",
        ]
        read_only_fields = ["dnr_marked_at"]

    def get_dnr_marked_by_name(self, obj):
        u = obj.dnr_marked_by
        return (u.get_full_name() or u.username) if u else ""

    def validate(self, attrs):
        return clean_name_parts(attrs, self.instance)

    def get_stay_count(self, obj):
        return obj.stays.filter(is_deleted=False).count()

    def get_last_stay(self, obj):
        s = obj.stays.filter(is_deleted=False).order_by("-check_in_date").first()
        return s.check_in_date if s else None


class PaymentSerializer(serializers.ModelSerializer):
    clerk_name = serializers.SerializerMethodField()

    class Meta:
        model = Payment
        fields = ["id", "stay", "amount", "method", "kind", "paid_at", "business_date", "clerk", "clerk_name", "is_initial", "notes"]
        read_only_fields = ["stay", "paid_at", "business_date", "clerk", "is_initial", "kind"]

    def get_clerk_name(self, obj):
        return (obj.clerk.get_full_name() or obj.clerk.username) if obj.clerk else ""

    def validate_amount(self, value):
        if value <= 0:
            raise serializers.ValidationError("Amount must be greater than zero.")
        return value


def _money(obj, attr, fallback):
    val = getattr(obj, attr, None)
    if val is None:
        val = fallback()
    return val or ZERO


class StaySerializer(serializers.ModelSerializer):
    """Read view of a stay, flat so tables are easy to render."""

    room_charge = serializers.DecimalField(max_digits=10, decimal_places=2, read_only=True)
    charges_total = serializers.DecimalField(max_digits=10, decimal_places=2, read_only=True)

    guest = GuestSerializer(read_only=True)
    room_number = serializers.CharField(source="room.number", read_only=True)
    room_type = serializers.CharField(source="room.room_type.name", read_only=True)
    clerk_name = serializers.SerializerMethodField()
    renewed_to = serializers.SerializerMethodField()
    early = serializers.SerializerMethodField()
    refunded = serializers.SerializerMethodField()
    deleted_by_name = serializers.SerializerMethodField()
    amount_paid = serializers.SerializerMethodField()
    cash_paid = serializers.SerializerMethodField()
    credit_paid = serializers.SerializerMethodField()
    balance = serializers.SerializerMethodField()
    payments = PaymentSerializer(many=True, read_only=True)

    class Meta:
        model = Stay
        fields = [
            "id", "guest", "room", "room_number", "room_type",
            "check_in_date", "check_in_time", "check_out_date", "check_out_time",
            "num_guests", "num_days", "rate_type", "periods", "rate", "room_charge", "adjustment",
            "pets", "pet_fee", "extra_persons", "extra_person_fee", "card_fee", "late_fee",
            "charges_total", "total_amount", "early", "refunded",
            "amount_paid", "cash_paid", "credit_paid", "balance",
            "clerk", "clerk_name", "comments", "status", "checked_out_at", "renewed_from", "renewed_to",
            "is_deleted", "deleted_at", "deleted_by_name", "payments", "created_at",
        ]

    def get_clerk_name(self, obj):
        return (obj.clerk.get_full_name() or obj.clerk.username) if obj.clerk else ""

    def get_early(self, obj):
        """Early checkout details (booking as it was, and the refund), or None."""
        snap = obj.early_snapshot
        if not snap:
            return None
        return {
            "original_check_out_date": snap.get("check_out_date"),
            "original_nights": snap.get("nights"),
            "original_room_charge": snap.get("room_charge"),
            "original_total": snap.get("total"),
            "method": snap.get("method"),
        }

    def get_refunded(self, obj):
        return str(-sum((p.amount for p in obj.payments.all() if p.kind == Payment.REFUND), ZERO))

    def get_renewed_to(self, obj):
        nxt = obj.renewals.filter(is_deleted=False).order_by("id").first()
        return nxt.id if nxt else None

    def get_deleted_by_name(self, obj):
        return (obj.deleted_by.get_full_name() or obj.deleted_by.username) if obj.deleted_by else ""

    def _sum(self, obj, method=None):
        qs = obj.payments.all()
        if method:
            qs = [p for p in qs if p.method == method]
        return sum((p.amount for p in qs), ZERO)

    def get_amount_paid(self, obj):
        return str(self._sum(obj))

    def get_cash_paid(self, obj):
        return str(self._sum(obj, Payment.CASH))

    def get_credit_paid(self, obj):
        return str(self._sum(obj, Payment.CREDIT))

    def get_balance(self, obj):
        return str(obj.total_amount - self._sum(obj))


def clean_name_parts(attrs, instance=None):
    """
    Guest name: first / middle / last (screens require first and last), kept with the full name.
    An old-style full name only is split into parts. Returns attrs.
    """
    parts_sent = any(k in attrs for k in ("first_name", "middle_name", "last_name"))
    if parts_sent:
        first = (attrs.get("first_name", getattr(instance, "first_name", "")) or "").strip()
        middle = (attrs.get("middle_name", getattr(instance, "middle_name", "")) or "").strip()
        last = (attrs.get("last_name", getattr(instance, "last_name", "")) or "").strip()
        attrs.update(first_name=first, middle_name=middle, last_name=last, name=join_name(first, middle, last))
    elif "name" in attrs:
        full = " ".join((attrs["name"] or "").split())
        attrs["first_name"], attrs["middle_name"], attrs["last_name"] = split_name(full)
        attrs["name"] = full
    if ("name" in attrs or instance is None) and not attrs.get("name") and not getattr(instance, "name", ""):
        raise serializers.ValidationError({"first_name": "Enter the guest's name."})
    return attrs


GUEST_FIELDS = ["name", "first_name", "middle_name", "last_name", "address", "city", "state", "zip_code", "phone", "car", "license_plate", "do_not_rent"]


class StayWriteSerializer(serializers.ModelSerializer):
    """Guest onboarding form. Creates or reuses the Guest, then the Stay, then any payments."""

    # guest details (flat on the form)
    guest_id = serializers.IntegerField(required=False, allow_null=True, write_only=True)
    name = serializers.CharField(max_length=150, required=False, allow_blank=True, write_only=True)
    first_name = serializers.CharField(max_length=60, required=False, allow_blank=True, write_only=True)
    middle_name = serializers.CharField(max_length=60, required=False, allow_blank=True, write_only=True)
    last_name = serializers.CharField(max_length=60, required=False, allow_blank=True, write_only=True)
    address = serializers.CharField(max_length=255, required=False, allow_blank=True, write_only=True)
    city = serializers.CharField(max_length=100, required=False, allow_blank=True, write_only=True)
    state = serializers.CharField(max_length=50, required=False, allow_blank=True, write_only=True)
    zip_code = serializers.CharField(max_length=20, required=False, allow_blank=True, write_only=True)
    phone = serializers.CharField(max_length=30, required=False, allow_blank=True, write_only=True)
    car = serializers.CharField(max_length=100, required=False, allow_blank=True, write_only=True)
    license_plate = serializers.CharField(max_length=30, required=False, allow_blank=True, write_only=True)
    do_not_rent = serializers.BooleanField(required=False, default=False, write_only=True)

    # money collected at check-in
    cash = serializers.DecimalField(max_digits=10, decimal_places=2, required=False, default=ZERO, write_only=True)
    credit = serializers.DecimalField(max_digits=10, decimal_places=2, required=False, default=ZERO, write_only=True)

    rate = serializers.DecimalField(max_digits=10, decimal_places=2, required=False)
    allow_overlap = serializers.BooleanField(required=False, default=False, write_only=True)
    # "Check out & check in again": id of the stay being checked out and renewed
    renew_from = serializers.IntegerField(required=False, allow_null=True, write_only=True)
    periods = serializers.IntegerField(required=False, allow_null=True, min_value=1)

    class Meta:
        model = Stay
        fields = [
            "id", "room", "check_in_date", "check_in_time", "check_out_date", "check_out_time",
            "num_guests", "rate_type", "periods", "rate", "adjustment", "pets", "pet_fee", "extra_persons", "extra_person_fee", "card_fee",
            "late_fee", "comments",
            "guest_id", *GUEST_FIELDS, "cash", "credit", "allow_overlap", "renew_from",
        ]

    def validate_room(self, room):
        client = self.context["request"].user.client
        if room.client_id != client.id or not room.is_active:
            raise serializers.ValidationError("Invalid room.")
        return room

    def validate(self, attrs):
        if not self.instance or any(k in attrs for k in ("name", "first_name", "middle_name", "last_name")):
            clean_name_parts(attrs, self.instance.guest if self.instance else None)
        inst = self.instance
        cin = attrs.get("check_in_date", inst.check_in_date if inst else None)
        cout = attrs.get("check_out_date", inst.check_out_date if inst else None)
        room = attrs.get("room", inst.room if inst else None)
        if cin and cout and cout < cin:
            raise serializers.ValidationError({"check_out_date": "Checkout cannot be before check-in."})
        if attrs.get("cash", ZERO) < 0 or attrs.get("credit", ZERO) < 0:
            raise serializers.ValidationError("Payments cannot be negative.")
        if cin and cout:
            rate = attrs.get("rate", inst.rate if inst else None)
            adj = attrs.get("adjustment", inst.adjustment if inst else ZERO) or ZERO
            rate_type = attrs.get("rate_type", inst.rate_type if inst else Stay.DAILY)
            given = attrs.get("periods")
            if given is None and inst and inst.rate_type == rate_type:
                given = inst.periods  # editing other fields keeps the clerk's week / month count
            periods = Stay.calc_periods(rate_type, cin, cout, given)
            attrs["periods"] = periods
            fees = ZERO
            for f in ("pet_fee", "extra_person_fee", "card_fee", "late_fee"):
                v = attrs.get(f, getattr(inst, f) if inst else ZERO) or ZERO
                if v < 0:
                    raise serializers.ValidationError({f: "Cannot be negative."})
                fees += v
            if rate is not None and rate * periods + fees + adj < 0:
                raise serializers.ValidationError({"balance": "Total cannot go below zero."})
        if room and cin and cout:
            end = cout if cout > cin else cin + timezone.timedelta(days=1)
            clash = Stay.objects.filter(
                room=room, is_deleted=False, status=Stay.CHECKED_IN,
                check_in_date__lt=end, check_out_date__gt=cin,
            )
            if inst:
                clash = clash.exclude(pk=inst.pk)
            if attrs.get("renew_from"):
                clash = clash.exclude(pk=attrs["renew_from"])  # the stay being renewed is checked out on save
            other = clash.select_related("guest").first()
            if other and not attrs.get("allow_overlap"):
                # The clerk can confirm and rent the same room again (allow_overlap=true).
                raise serializers.ValidationError({
                    "overlap": f"Room {room.number} is occupied by {other.guest.name} "
                               f"until {other.check_out_date:%m/%d/%Y}."
                })
        attrs.pop("allow_overlap", None)
        return attrs

    def _guest_data(self, attrs):
        return {f: attrs.pop(f) for f in GUEST_FIELDS if f in attrs}

    @transaction.atomic
    def create(self, attrs):
        request = self.context["request"]
        client = request.user.client
        guest_id = attrs.pop("guest_id", None)
        old = None
        renew_id = attrs.pop("renew_from", None)
        if renew_id:
            old = Stay.objects.filter(client=client, pk=renew_id, is_deleted=False).first()
            if old is None:
                raise serializers.ValidationError({"renew_from": "Stay to renew not found."})
            guest_id = guest_id or old.guest_id
        guest_data = self._guest_data(attrs)
        cash = attrs.pop("cash", ZERO) or ZERO
        credit = attrs.pop("credit", ZERO) or ZERO

        guest = None
        if guest_id:
            guest = Guest.objects.filter(client=client, pk=guest_id).first()
        if guest is None and guest_data.get("phone"):
            guest = Guest.objects.filter(client=client, phone=guest_data["phone"]).first()
        if guest is None:
            guest = Guest(client=client)
        for k, v in guest_data.items():
            setattr(guest, k, v)
        guest.save()

        if "rate" not in attrs or attrs["rate"] is None:
            rt = attrs["room"].room_type
            attrs["rate"] = {
                Stay.WEEKLY: rt.weekly_rate or rt.default_rate * 7,
                Stay.MONTHLY: rt.monthly_rate or rt.default_rate * 30,
            }.get(attrs.get("rate_type", Stay.DAILY), rt.default_rate)

        stay = Stay.objects.create(client=client, guest=guest, clerk=request.user, renewed_from=old, **attrs)
        if old and old.status == Stay.CHECKED_IN:
            old.status = Stay.CHECKED_OUT
            old.checked_out_at = timezone.now()
            old.save()
        now = timezone.now()
        for amount, method in ((cash, Payment.CASH), (credit, Payment.CREDIT)):
            if amount > 0:
                Payment.objects.create(
                    stay=stay, amount=amount, method=method, paid_at=now,
                    clerk=request.user, is_initial=True,
                )
        return stay

    @transaction.atomic
    def update(self, stay, attrs):
        attrs.pop("guest_id", None)
        attrs.pop("renew_from", None)
        attrs.pop("cash", None)
        attrs.pop("credit", None)
        guest_data = self._guest_data(attrs)
        for k, v in guest_data.items():
            setattr(stay.guest, k, v)
        stay.guest.save()
        for k, v in attrs.items():
            setattr(stay, k, v)
        stay.save()
        return stay

    def to_representation(self, instance):
        return StaySerializer(instance, context=self.context).data


class NoteSerializer(serializers.ModelSerializer):
    room_number = serializers.CharField(source="room.number", read_only=True, default=None)
    created_by_name = serializers.SerializerMethodField()

    class Meta:
        model = Note
        fields = ["id", "date", "room", "room_number", "text", "created_by", "created_by_name", "created_at", "updated_at"]
        read_only_fields = ["created_by", "created_at", "updated_at"]

    def get_created_by_name(self, obj):
        return (obj.created_by.get_full_name() or obj.created_by.username) if obj.created_by else ""

    def validate_room(self, room):
        if room and room.client_id != self.context["request"].user.client_id:
            raise serializers.ValidationError("Invalid room.")
        return room

    def validate_text(self, value):
        if not value.strip():
            raise serializers.ValidationError("Note cannot be empty.")
        return value.strip()


class ExpenseSerializer(serializers.ModelSerializer):
    clerk_name = serializers.SerializerMethodField()
    can_edit = serializers.SerializerMethodField()

    class Meta:
        model = Expense
        fields = ["id", "business_date", "amount", "method", "description", "clerk", "clerk_name", "created_at", "can_edit"]
        read_only_fields = ["clerk", "created_at"]
        extra_kwargs = {"business_date": {"required": False}}

    def get_clerk_name(self, obj):
        return (obj.clerk.get_full_name() or obj.clerk.username) if obj.clerk else ""

    def get_can_edit(self, obj):
        request = self.context.get("request")
        return bool(request and expense_editable(obj, request.user))

    def validate_amount(self, v):
        if v <= 0:
            raise serializers.ValidationError("Amount must be greater than zero.")
        return v

    def validate_description(self, v):
        if not v.strip():
            raise serializers.ValidationError("Enter what the money was spent on.")
        return v.strip()

    def validate_business_date(self, v):
        from django.utils import timezone as tz
        from . import business
        client = self.context["request"].user.client
        from accounts.models import User
        biz = business.business_date(client)
        if v > max(tz.localdate(), biz):
            raise serializers.ValidationError("Date cannot be in the future.")
        if self.context["request"].user.role != User.CLIENT_ADMIN and v != biz:
            raise serializers.ValidationError("Only the admin can add an expense for another day.")
        return v


def expense_editable(expense, user):
    """Client admin: any expense. Front desk: only their own, on the current business day."""
    from accounts.models import User
    from . import business
    if user.role == User.CLIENT_ADMIN:
        return True
    return expense.clerk_id == user.id and expense.business_date == business.business_date(expense.client)
