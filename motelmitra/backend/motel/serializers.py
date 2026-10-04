from decimal import Decimal

from django.db import transaction
from django.utils import timezone
from rest_framework import serializers

from .models import Guest, Note, Payment, Room, RoomType, Stay

ZERO = Decimal("0.00")


class RoomTypeSerializer(serializers.ModelSerializer):
    room_count = serializers.SerializerMethodField()

    class Meta:
        model = RoomType
        fields = ["id", "name", "default_rate", "description", "is_active", "room_count"]

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

    class Meta:
        model = Room
        fields = ["id", "number", "room_type", "room_type_name", "default_rate", "floor", "notes", "is_active"]

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

    class Meta:
        model = Guest
        fields = [
            "id", "name", "address", "city", "state", "zip_code", "phone", "car",
            "license_plate", "do_not_rent", "stay_count", "last_stay", "created_at",
        ]

    def get_stay_count(self, obj):
        return obj.stays.filter(is_deleted=False).count()

    def get_last_stay(self, obj):
        s = obj.stays.filter(is_deleted=False).order_by("-check_in_date").first()
        return s.check_in_date if s else None


class PaymentSerializer(serializers.ModelSerializer):
    clerk_name = serializers.SerializerMethodField()

    class Meta:
        model = Payment
        fields = ["id", "stay", "amount", "method", "paid_at", "clerk", "clerk_name", "is_initial", "notes"]
        read_only_fields = ["stay", "paid_at", "clerk", "is_initial"]

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

    guest = GuestSerializer(read_only=True)
    room_number = serializers.CharField(source="room.number", read_only=True)
    room_type = serializers.CharField(source="room.room_type.name", read_only=True)
    clerk_name = serializers.SerializerMethodField()
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
            "num_guests", "num_days", "rate", "adjustment", "total_amount",
            "amount_paid", "cash_paid", "credit_paid", "balance",
            "clerk", "clerk_name", "comments", "status", "checked_out_at",
            "is_deleted", "deleted_at", "deleted_by_name", "payments", "created_at",
        ]

    def get_clerk_name(self, obj):
        return (obj.clerk.get_full_name() or obj.clerk.username) if obj.clerk else ""

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


GUEST_FIELDS = ["name", "address", "city", "state", "zip_code", "phone", "car", "license_plate", "do_not_rent"]


class StayWriteSerializer(serializers.ModelSerializer):
    """Guest onboarding form. Creates or reuses the Guest, then the Stay, then any payments."""

    # guest details (flat on the form)
    guest_id = serializers.IntegerField(required=False, allow_null=True, write_only=True)
    name = serializers.CharField(max_length=150, write_only=True)
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

    class Meta:
        model = Stay
        fields = [
            "id", "room", "check_in_date", "check_in_time", "check_out_date", "check_out_time",
            "num_guests", "rate", "adjustment", "comments",
            "guest_id", *GUEST_FIELDS, "cash", "credit", "allow_overlap",
        ]

    def validate_room(self, room):
        client = self.context["request"].user.client
        if room.client_id != client.id or not room.is_active:
            raise serializers.ValidationError("Invalid room.")
        return room

    def validate(self, attrs):
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
            if rate is not None and rate * max((cout - cin).days, 1) + adj < 0:
                raise serializers.ValidationError({"balance": "Total cannot go below zero."})
        if room and cin and cout:
            end = cout if cout > cin else cin + timezone.timedelta(days=1)
            clash = Stay.objects.filter(
                room=room, is_deleted=False, status=Stay.CHECKED_IN,
                check_in_date__lt=end, check_out_date__gt=cin,
            )
            if inst:
                clash = clash.exclude(pk=inst.pk)
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
            attrs["rate"] = attrs["room"].room_type.default_rate

        stay = Stay.objects.create(client=client, guest=guest, clerk=request.user, **attrs)
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
