from decimal import Decimal

from django.db import transaction
from django.utils import timezone
from rest_framework import serializers

from .models import CustomReport, Expense, Guest, RoomIssue, Note, Payment, Photo, attach_photos, Room, RoomType, Stay, join_name, split_name

ZERO = Decimal("0.00")


class RoomTypeSerializer(serializers.ModelSerializer):
    room_count = serializers.SerializerMethodField()

    class Meta:
        model = RoomType
        fields = ["id", "name", "default_rate", "weekly_rate", "monthly_rate", "description", "is_active", "room_count"]

    def get_room_count(self, obj):
        return obj.rooms.filter(is_active=True).count()

    def validate(self, attrs):
        for k in ("default_rate", "weekly_rate", "monthly_rate"):
            if attrs.get(k) is not None and attrs[k] < 0:
                raise serializers.ValidationError({k: "Rate cannot be negative."})
        return attrs

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
            "license_plate", "dl_number", "do_not_rent", "dnr_reason", "dnr_marked_at", "dnr_marked_by_name",
            "stay_count", "last_stay", "created_at",
            "cash_paid", "card_paid", "check_paid", "balance", "is_deleted", "deleted_at", "deleted_by_name",
        ]
        read_only_fields = ["dnr_marked_at", "is_deleted", "deleted_at"]

    # money over the guest's stays (deleted stays left out); the directory list annotates these
    # in the database, other screens fall back to working them out here
    cash_paid = serializers.SerializerMethodField()
    card_paid = serializers.SerializerMethodField()
    check_paid = serializers.SerializerMethodField()
    balance = serializers.SerializerMethodField()
    deleted_by_name = serializers.SerializerMethodField()

    def _money(self, obj):
        if not hasattr(obj, "_money"):
            if hasattr(obj, "ann_cash"):
                q = Decimal("0.01")
                obj._money = tuple(Decimal(v or 0).quantize(q) for v in (obj.ann_cash, obj.ann_card, obj.ann_total, obj.ann_check))
            else:
                pays = Payment.objects.filter(stay__guest=obj, stay__is_deleted=False)
                cash = sum((p.amount for p in pays if p.method == Payment.CASH), ZERO)
                card = sum((p.amount for p in pays if p.method == Payment.CREDIT), ZERO)
                chk = sum((p.amount for p in pays if p.method == Payment.CHECK), ZERO)
                total = sum((s.total_amount for s in obj.stays.filter(is_deleted=False)), ZERO)
                obj._money = (cash, card, total, chk)
        return obj._money

    def get_cash_paid(self, obj):
        return str(self._money(obj)[0])

    def get_card_paid(self, obj):
        return str(self._money(obj)[1])

    def get_check_paid(self, obj):
        return str(self._money(obj)[3])

    def get_balance(self, obj):
        cash, card, total, chk = self._money(obj)
        return str(total - cash - card - chk)

    def get_deleted_by_name(self, obj):
        u = obj.deleted_by
        return (u.get_full_name() or u.username) if u else ""

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
    check_paid = serializers.SerializerMethodField()
    balance = serializers.SerializerMethodField()
    payments = PaymentSerializer(many=True, read_only=True)
    room_rates = serializers.SerializerMethodField()

    class Meta:
        model = Stay
        fields = [
            "id", "guest", "room", "room_number", "room_type",
            "check_in_date", "check_in_time", "check_out_date", "check_out_time",
            "num_guests", "num_days", "rate_type", "periods", "rate", "room_charge", "adjustment",
            "pets", "pet_fee", "extra_persons", "extra_person_fee", "card_fee", "late_fee", "early_checkin_fee", "damage_fee",
            "charges_total", "total_amount", "early", "refunded",
            "amount_paid", "cash_paid", "credit_paid", "check_paid", "balance",
            "clerk", "clerk_name", "comments", "status", "checked_out_at", "renewed_from", "renewed_to",
            "is_deleted", "deleted_at", "deleted_by_name", "payments", "created_at",
            "extra_stay_nights", "extra_stay_charge", "room_rates", "balance_carried",
        ]

    def get_room_rates(self, obj):
        """The room type's current rates (Add stay offers daily / weekly / monthly like check-in)."""
        rt = obj.room.room_type
        daily = Decimal(rt.default_rate or 0)
        return {"DAILY": str(daily.quantize(Decimal("0.01"))),
                "WEEKLY": str((Decimal(rt.weekly_rate or 0) or daily * 7).quantize(Decimal("0.01"))),
                "MONTHLY": str((Decimal(rt.monthly_rate or 0) or daily * 30).quantize(Decimal("0.01")))}

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

    def get_check_paid(self, obj):
        return str(self._sum(obj, Payment.CHECK))

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


GUEST_FIELDS = ["name", "first_name", "middle_name", "last_name", "address", "city", "state", "zip_code", "phone", "car", "license_plate", "dl_number", "do_not_rent"]


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
    dl_number = serializers.CharField(max_length=40, required=False, allow_blank=True, write_only=True)
    do_not_rent = serializers.BooleanField(required=False, default=False, write_only=True)

    # money collected at check-in
    cash = serializers.DecimalField(max_digits=10, decimal_places=2, required=False, default=ZERO, write_only=True)
    credit = serializers.DecimalField(max_digits=10, decimal_places=2, required=False, default=ZERO, write_only=True)
    check = serializers.DecimalField(max_digits=10, decimal_places=2, required=False, default=ZERO, write_only=True)

    rate = serializers.DecimalField(max_digits=10, decimal_places=2, required=False)
    allow_overlap = serializers.BooleanField(required=False, default=False, write_only=True)
    # "Check out & check in again": id of the stay being checked out and renewed
    renew_from = serializers.IntegerField(required=False, allow_null=True, write_only=True)
    # the clerk saw "room not ready / out of order" and chose to rent it anyway (recorded with their name)
    room_status_ok = serializers.BooleanField(required=False, default=False, write_only=True)
    # check in again: add the old stay's unpaid balance to this new stay (yes) or leave it on the old one (no)
    carry_balance = serializers.BooleanField(required=False, default=False, write_only=True)
    periods = serializers.IntegerField(required=False, allow_null=True, min_value=1)
    # photos taken on the form before saving (DL front / back), and "use the guest's last DL photo"
    photo_ids = serializers.ListField(child=serializers.IntegerField(), required=False, write_only=True)
    reuse_dl = serializers.BooleanField(required=False, default=False, write_only=True)

    class Meta:
        model = Stay
        fields = [
            "id", "room", "check_in_date", "check_in_time", "check_out_date", "check_out_time",
            "num_guests", "rate_type", "periods", "rate", "adjustment", "pets", "pet_fee", "extra_persons", "extra_person_fee", "card_fee",
            "late_fee", "early_checkin_fee", "comments", "photo_ids", "reuse_dl",
            "guest_id", *GUEST_FIELDS, "cash", "credit", "check", "allow_overlap", "renew_from", "room_status_ok",
            "carry_balance",
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
        if attrs.get("cash", ZERO) < 0 or attrs.get("credit", ZERO) < 0 or attrs.get("check", ZERO) < 0:
            raise serializers.ValidationError("Payments cannot be negative.")
        guests = attrs.get("num_guests", inst.num_guests if inst else 1)
        if guests is not None and not (1 <= guests <= 50):
            raise serializers.ValidationError({"num_guests": "Number of guests must be between 1 and 50."})
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
            for f in ("pet_fee", "extra_person_fee", "card_fee", "late_fee", "early_checkin_fee"):
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
        # new check-in into a room that is not ready: ask first (renting it again to the same guest is fine)
        if not inst and room and room.hk_status != room.READY and not attrs.get("room_status_ok"):
            renew = Stay.objects.filter(pk=attrs.get("renew_from"), room=room).exists() if attrs.get("renew_from") else False
            if not renew:
                label = dict(room.HK_CHOICES)[room.hk_status]
                why = f" ({room.hk_note})" if room.hk_note else ""
                raise serializers.ValidationError({
                    "room_status": f"Room {room.number} is {label.upper()}{why}. Rent it anyway?",
                    "room_status_code": room.hk_status,
                })
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
        photo_ids = attrs.pop("photo_ids", None) or []
        reuse_dl = attrs.pop("reuse_dl", False)
        cash = attrs.pop("cash", ZERO) or ZERO
        credit = attrs.pop("credit", ZERO) or ZERO
        check = attrs.pop("check", ZERO) or ZERO
        status_ok = attrs.pop("room_status_ok", False)
        carry = attrs.pop("carry_balance", False)

        guest = None
        if guest_id:
            guest = Guest.objects.filter(client=client, pk=guest_id).first()
        if guest is None and guest_data.get("dl_number", "").strip():
            dl = "".join(ch for ch in guest_data["dl_number"] if ch.isalnum()).upper()
            guest = next((g for g in Guest.objects.filter(client=client, is_deleted=False).exclude(dl_number="")
                          if "".join(ch for ch in g.dl_number if ch.isalnum()).upper() == dl), None)
        if guest is None and guest_data.get("phone"):
            guest = Guest.objects.filter(client=client, phone=guest_data["phone"], is_deleted=False).first()
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

        carried = ZERO
        if old and carry:
            old_owed = (old.total_amount - sum((p.amount for p in old.payments.all()), ZERO)).quantize(Decimal("0.01"))
            carried = max(old_owed, ZERO)
        if carried > 0:
            attrs["balance_carried"] = carried
            note = f"Balance {carried} from previous stay ({old.check_in_date:%m/%d/%Y} -> {old.check_out_date:%m/%d/%Y}) added."
            attrs["comments"] = (note + "\n" + attrs["comments"]) if attrs.get("comments") else note
        stay = Stay.objects.create(client=client, guest=guest, clerk=request.user, renewed_from=old, **attrs)
        if carried > 0:
            old.balance_carried = Decimal(old.balance_carried or 0) - carried
            line = f"Balance {carried} moved to the next stay (checked in again {stay.check_in_date:%m/%d/%Y})."
            old.comments = (old.comments + "\n" if old.comments else "") + line
            old.save()
        room = stay.room
        if old and old.room_id == room.id:
            # checked out and checked in again in the same room: the guest never left, nothing to clean
            if room.hk_status in (room.DIRTY, room.CLEANING):
                from .views import set_room_status
                set_room_status(room, room.READY, request.user, note="Guest checked in again", stay=stay)
        elif room.hk_status != room.READY and status_ok:
            # rented while not ready / out of order: keep a record of who did it
            from .models import RoomStatusLog
            from . import business
            RoomStatusLog.objects.create(client=client, room=room, action=RoomStatusLog.OVERRIDE,
                                         from_status=room.hk_status, to_status=room.hk_status,
                                         note=f"Checked in {guest.name} while room was {dict(room.HK_CHOICES)[room.hk_status]}",
                                         stay=stay, user=request.user, business_date=business.business_date(client))
        if old and old.status == Stay.CHECKED_IN:
            old.status = Stay.CHECKED_OUT
            old.checked_out_at = timezone.now()
            old.save()
        now = timezone.now()
        for amount, method in ((cash, Payment.CASH), (credit, Payment.CREDIT), (check, Payment.CHECK)):
            if amount > 0:
                Payment.objects.create(
                    stay=stay, amount=amount, method=method, paid_at=now,
                    clerk=request.user, is_initial=True,
                )
        attach_photos(stay, photo_ids, reuse_dl)
        return stay

    @transaction.atomic
    def update(self, stay, attrs):
        attrs.pop("guest_id", None)
        attrs.pop("renew_from", None)
        attrs.pop("room_status_ok", None)
        attrs.pop("carry_balance", None)
        attrs.pop("cash", None)
        attrs.pop("credit", None)
        attrs.pop("check", None)
        photo_ids = attrs.pop("photo_ids", None) or []
        attrs.pop("reuse_dl", None)
        guest_data = self._guest_data(attrs)
        for k, v in guest_data.items():
            setattr(stay.guest, k, v)
        stay.guest.save()
        old_room = stay.room_id
        for k, v in attrs.items():
            setattr(stay, k, v)
        stay.save()
        attach_photos(stay, photo_ids, False)
        if stay.room_id != old_room:   # room changed: photos move to the new room's folder
            from .models import place_photo
            for ph in stay.photos.all():
                place_photo(ph)
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


class PhotoSerializer(serializers.ModelSerializer):
    url = serializers.SerializerMethodField()
    file_name = serializers.SerializerMethodField()
    uploaded_by_name = serializers.SerializerMethodField()
    kind_label = serializers.CharField(source="get_kind_display", read_only=True)

    class Meta:
        model = Photo
        fields = ["id", "kind", "kind_label", "stay", "guest", "via", "url", "file_name", "uploaded_by_name", "created_at"]

    def get_url(self, obj):
        return f"/api/photos/{obj.id}/file/"

    def get_file_name(self, obj):
        return obj.file.name

    def get_uploaded_by_name(self, obj):
        u = obj.uploaded_by
        return (u.get_full_name() or u.username) if u else ""


class CustomReportSerializer(serializers.ModelSerializer):
    created_by_name = serializers.SerializerMethodField()
    can_change = serializers.SerializerMethodField()

    class Meta:
        model = CustomReport
        fields = ["id", "name", "config", "created_by_name", "can_change", "created_at", "updated_at"]

    def get_created_by_name(self, obj):
        u = obj.created_by
        return (u.get_full_name() or u.username) if u else ""

    def get_can_change(self, obj):
        req = self.context.get("request")
        if not req:
            return False
        return req.user.role == "CLIENT_ADMIN" or obj.created_by_id == req.user.id

    def validate_name(self, v):
        if not v.strip():
            raise serializers.ValidationError("Give the report a name.")
        return v

    def validate_config(self, v):
        if not isinstance(v, dict) or v.get("source") not in ("stays", "payments", "expenses", "guests", "problems"):
            raise serializers.ValidationError("Pick a source.")
        return v


class RoomIssueSerializer(serializers.ModelSerializer):
    room_number = serializers.CharField(source="room.number", read_only=True)
    room_type = serializers.CharField(source="room.room_type.name", read_only=True)
    room_status = serializers.CharField(source="room.hk_status", read_only=True)
    category_label = serializers.CharField(source="get_category_display", read_only=True)
    priority_label = serializers.CharField(source="get_priority_display", read_only=True)
    status_label = serializers.CharField(source="get_status_display", read_only=True)
    reported_by_name = serializers.SerializerMethodField()
    fixed_by_name = serializers.SerializerMethodField()
    photos = serializers.SerializerMethodField()

    class Meta:
        model = RoomIssue
        fields = ["id", "room", "room_number", "room_type", "room_status", "category", "category_label", "priority",
                  "priority_label", "description", "status", "status_label", "made_out_of_order",
                  "reported_by_name", "fixed_by_name", "fixed_at", "history", "photos", "created_at", "updated_at"]
        read_only_fields = ["made_out_of_order", "fixed_at", "history", "created_at", "updated_at"]

    def _name(self, u):
        return (u.get_full_name() or u.username) if u else ""

    def get_reported_by_name(self, obj):
        return self._name(obj.reported_by)

    def get_fixed_by_name(self, obj):
        return self._name(obj.fixed_by)

    def get_photos(self, obj):
        return [{"id": p.id, "url": f"/api/photos/{p.id}/file/"} for p in obj.photos.all()]

    def validate_room(self, room):
        if room.client_id != self.context["request"].user.client_id:
            raise serializers.ValidationError("Invalid room.")
        if self.instance and room.pk != self.instance.room_id:
            raise serializers.ValidationError("A problem cannot move to another room. Report a new one.")
        return room

    def validate_description(self, v):
        if not v.strip():
            raise serializers.ValidationError("Describe the problem.")
        return v.strip()
