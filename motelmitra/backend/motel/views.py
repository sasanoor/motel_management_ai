import datetime
from decimal import Decimal

from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from rest_framework import mixins, status, viewsets
from rest_framework.decorators import action, api_view, permission_classes
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.permissions import BasePermission, SAFE_METHODS
from rest_framework.response import Response

from accounts.models import User
from accounts.permissions import (
    IsClientStaff, IsClientStaffOrSuperAdmin, IsMaintenanceOrStaff, get_request_client,
)

from . import business, early
from .models import DayClose, Guest, Note, Payment, Room, RoomType, Stay
from .serializers import (
    GuestSerializer, NoteSerializer, PaymentSerializer, RoomSerializer, RoomTypeSerializer,
    StaySerializer, StayWriteSerializer,
)

ZERO = Decimal("0.00")


# ------------------------------------------------------------------ helpers
class AdminWriteStaffRead(BasePermission):
    """Client users can read; only client admin can create/edit/delete."""

    def has_permission(self, request, view):
        if not IsClientStaff().has_permission(request, view):
            return False
        if request.method in SAFE_METHODS:
            return True
        return request.user.role == User.CLIENT_ADMIN


def parse_date(value, default=None, field="date"):
    if not value:
        return default or timezone.localdate()
    try:
        return datetime.date.fromisoformat(value)
    except ValueError:
        raise ValidationError({field: "Use YYYY-MM-DD."})


def stay_qs(client):
    return (
        Stay.objects.filter(client=client)
        .select_related("guest", "room", "room__room_type", "clerk", "deleted_by")
        .prefetch_related("payments", "payments__clerk")
    )


def paid(stay, method=None):
    return sum((p.amount for p in stay.payments.all() if method is None or p.method == method), ZERO)


def paid_on(stay, day, method=None):
    """Money received for a stay on one business day (net of refunds)."""
    return sum((p.amount for p in stay.payments.all()
                if p.business_date == day and (method is None or p.method == method)), ZERO)


def pay_type(p):
    if p.kind == Payment.REFUND:
        return "Refund"
    return "Check-in" if p.is_initial else "Balance payment"


def occupying_on(stays, day):
    """Stays that hold a room on the night of `day`."""
    out = []
    for s in stays:
        last_night = s.check_out_date if s.check_out_date > s.check_in_date else s.check_in_date + datetime.timedelta(days=1)
        if not (s.check_in_date <= day < last_night):
            continue
        if s.status == Stay.CHECKED_OUT and s.checked_out_at and timezone.localdate(s.checked_out_at) <= day:
            continue
        out.append(s)
    return out


# ------------------------------------------------------------------ setup
class RoomTypeViewSet(viewsets.ModelViewSet):
    permission_classes = [AdminWriteStaffRead]
    serializer_class = RoomTypeSerializer

    def get_queryset(self):
        return RoomType.objects.filter(client=self.request.user.client)

    def perform_create(self, serializer):
        serializer.save(client=self.request.user.client)

    def destroy(self, request, *args, **kwargs):
        rt = self.get_object()
        if rt.rooms.exists():
            rt.is_active = False
            rt.save()
            return Response({"detail": "Room type has rooms, so it was deactivated."})
        rt.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class RoomViewSet(viewsets.ModelViewSet):
    permission_classes = [AdminWriteStaffRead]
    serializer_class = RoomSerializer

    def get_queryset(self):
        qs = Room.objects.filter(client=self.request.user.client).select_related("room_type")
        if self.request.query_params.get("active") == "1":
            qs = qs.filter(is_active=True)
        return qs

    def perform_create(self, serializer):
        serializer.save(client=self.request.user.client)

    def destroy(self, request, *args, **kwargs):
        room = self.get_object()
        if room.stays.exists():
            room.is_active = False
            room.save()
            return Response({"detail": "Room has stay history, so it was deactivated."})
        room.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=False, methods=["get"])
    def board(self, request):
        """Every active room with its status for a date (room board / check-in picker)."""
        client = request.user.client
        day = parse_date(request.query_params.get("date"), business.business_date(client))
        stays = stay_qs(client).filter(is_deleted=False, check_in_date__lte=day, check_out_date__gte=day)
        by_room = {s.room_id: s for s in occupying_on(stays, day)}
        rooms = Room.objects.filter(client=client, is_active=True).select_related("room_type")
        data = []
        for r in rooms:
            s = by_room.get(r.id)
            data.append({
                "id": r.id, "number": r.number, "room_type": r.room_type.name,
                "default_rate": str(r.room_type.default_rate),
                "weekly_rate": str(r.room_type.weekly_rate),
                "monthly_rate": str(r.room_type.monthly_rate),
                "occupied": bool(s),
                "stay_id": s.id if s else None,
                "guest_name": s.guest.name if s else None,
                "check_out_date": s.check_out_date if s else None,
            })
        return Response(data)


# ------------------------------------------------------------------ guests
def _digits(s):
    return "".join(ch for ch in (s or "") if ch.isdigit())


def _plate(s):
    return "".join(ch for ch in (s or "") if ch.isalnum()).upper()


def find_dnr(client, name="", phone="", plate=""):
    """
    Do Not Rent guests matching any of name / phone / plate.
    Phone compares digits only (806-555-0111 = (806) 555 0111), plate ignores spaces and dashes,
    name matches the full name, ignoring case.
    Returns [(guest, [reasons])].
    """
    name = (name or "").strip().lower()
    phone_d = _digits(phone)
    plate_n = _plate(plate)
    out = []
    for g in Guest.objects.filter(client=client, do_not_rent=True).select_related("dnr_marked_by"):
        why = []
        if phone_d and len(phone_d) >= 7 and _digits(g.phone) and (
            _digits(g.phone).endswith(phone_d[-10:]) or phone_d.endswith(_digits(g.phone)[-10:])
        ):
            why.append("phone")
        if plate_n and len(plate_n) >= 3 and _plate(g.license_plate) == plate_n:
            why.append("plate")
        if name and len(name) >= 3 and " ".join(g.name.lower().split()) == " ".join(name.split()):
            why.append("name")
        if why:
            out.append((g, why))
    return out


class GuestViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, mixins.CreateModelMixin,
                   mixins.UpdateModelMixin, viewsets.GenericViewSet):
    """
    Guests. POST adds someone straight to the Do Not Rent list (e.g. past customers);
    if a guest with the same phone or plate already exists, that guest is flagged instead of duplicated.
    """
    permission_classes = [IsClientStaff]
    serializer_class = GuestSerializer

    def get_queryset(self):
        qs = Guest.objects.filter(client=self.request.user.client)
        q = self.request.query_params.get("q")
        if q:
            qs = qs.filter(Q(name__icontains=q) | Q(phone__icontains=q) | Q(license_plate__icontains=q))
        if self.request.query_params.get("dnr") == "1":
            qs = qs.filter(do_not_rent=True)
        return qs[:200] if self.action == "list" else qs

    def create(self, request, *args, **kwargs):
        client = request.user.client
        ser = self.get_serializer(data=request.data)
        ser.is_valid(raise_exception=True)
        data = ser.validated_data
        existing = None
        if data.get("phone") and len(_digits(data["phone"])) >= 7:
            existing = next((g for g in Guest.objects.filter(client=client)
                             if _digits(g.phone) and _digits(g.phone)[-10:] == _digits(data["phone"])[-10:]), None)
        if existing is None and data.get("license_plate"):
            existing = next((g for g in Guest.objects.filter(client=client)
                             if _plate(g.license_plate) == _plate(data["license_plate"])), None)
        if existing:
            for k, v in data.items():
                if v not in ("", None) or k in ("do_not_rent",):
                    setattr(existing, k, v)
            if existing.do_not_rent and not existing.dnr_marked_by_id:
                existing.dnr_marked_by = request.user
            existing.save()
            out = GuestSerializer(existing).data
            out["merged"] = True
            return Response(out, status=status.HTTP_200_OK)
        guest = ser.save(client=client, dnr_marked_by=request.user if data.get("do_not_rent") else None)
        return Response(GuestSerializer(guest).data, status=status.HTTP_201_CREATED)

    def perform_update(self, serializer):
        was = serializer.instance.do_not_rent
        guest = serializer.save()
        if guest.do_not_rent and not was:
            guest.dnr_marked_by = self.request.user
            guest.save()

    @action(detail=False, methods=["get"])
    def dnr_check(self, request):
        """Check-in form "Check DNR" button: is this name / phone / plate on the Do Not Rent list?"""
        p = request.query_params
        hits = find_dnr(request.user.client, p.get("name"), p.get("phone"), p.get("plate"))
        checked = [k for k in ("name", "phone", "plate") if (p.get(k) or "").strip()]
        return Response({
            "checked": checked,
            "matches": [{**GuestSerializer(g).data, "matched_on": why} for g, why in hits],
        })

    @action(detail=False, methods=["get"])
    def check(self, request):
        """
        Look up a returning guest by phone / plate / name.
        The check-in form calls this to autofill and to raise the Do Not Rent warning.
        """
        client = request.user.client
        phone = (request.query_params.get("phone") or "").strip()
        plate = (request.query_params.get("plate") or "").strip()
        name = (request.query_params.get("name") or "").strip()
        cond = Q()
        if phone:
            cond |= Q(phone=phone)
        if plate:
            cond |= Q(license_plate__iexact=plate)
        if name and len(name) >= 3:
            cond |= Q(name__iexact=name)
        if not cond:
            return Response([])
        guests = Guest.objects.filter(client=client).filter(cond).order_by("-do_not_rent", "-updated_at")[:5]
        return Response(GuestSerializer(guests, many=True).data)

    @action(detail=True, methods=["get"])
    def stays(self, request, pk=None):
        guest = self.get_object()
        qs = stay_qs(request.user.client).filter(guest=guest, is_deleted=False)
        return Response(StaySerializer(qs, many=True).data)


# ------------------------------------------------------------------ stays
class StayViewSet(viewsets.ModelViewSet):
    """
    Guest onboarding (check-ins).
    DELETE is a soft delete (client admin only). Deleted records are listed
    under /stays/deleted/ and can be recovered with /stays/{id}/restore/.
    """

    permission_classes = [IsClientStaff]

    def get_serializer_class(self):
        if self.action in ("create", "update", "partial_update"):
            return StayWriteSerializer
        return StaySerializer

    def get_queryset(self):
        client = self.request.user.client
        if self.action in ("deleted", "restore"):
            return stay_qs(client).filter(is_deleted=True).order_by("-deleted_at")
        qs = stay_qs(client).filter(is_deleted=False)
        if self.action != "list":
            return qs  # filters below are for the list only (early_quote also takes ?date=)
        p = self.request.query_params
        if p.get("date"):
            d = parse_date(p["date"])
            qs = qs.filter(check_in_date__lte=d, check_out_date__gte=d)
        if p.get("check_in_date"):
            qs = qs.filter(check_in_date=parse_date(p["check_in_date"], field="check_in_date"))
        if p.get("check_out_date"):
            qs = qs.filter(check_out_date=parse_date(p["check_out_date"], field="check_out_date"))
        if p.get("status"):
            qs = qs.filter(status=p["status"])
        if p.get("q"):
            q = p["q"]
            qs = qs.filter(
                Q(guest__name__icontains=q) | Q(guest__phone__icontains=q)
                | Q(guest__license_plate__icontains=q) | Q(room__number__iexact=q)
            )
        return qs

    def list(self, request, *args, **kwargs):
        stays = list(self.get_queryset()[:500])
        if request.query_params.get("has_balance") == "1":
            stays = [s for s in stays if s.total_amount - paid(s) > 0]
        return Response(StaySerializer(stays, many=True).data)

    def destroy(self, request, *args, **kwargs):
        if request.user.role != User.CLIENT_ADMIN:
            raise PermissionDenied("Only the client admin can delete guests.")
        stay = self.get_object()
        stay.is_deleted = True
        stay.deleted_at = timezone.now()
        stay.deleted_by = request.user
        stay.save()
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=False, methods=["get"])
    def deleted(self, request):
        if request.user.role != User.CLIENT_ADMIN:
            raise PermissionDenied("Only the client admin can view deleted guests.")
        return Response(StaySerializer(self.get_queryset(), many=True).data)

    @action(detail=True, methods=["post"])
    def restore(self, request, pk=None):
        if request.user.role != User.CLIENT_ADMIN:
            raise PermissionDenied("Only the client admin can recover guests.")
        stay = self.get_object()
        stay.is_deleted = False
        stay.deleted_at = None
        stay.deleted_by = None
        stay.save()
        return Response(StaySerializer(stay).data)

    @action(detail=True, methods=["post"])
    def payments(self, request, pk=None):
        """Add a balance payment. It is linked to the stay, so it rolls into the check-in date report."""
        stay = self.get_object()
        if "cash" in request.data or "credit" in request.data:
            # Same as check-in: cash and / or card in one go, card fee added to the stay's charges.
            cash = _decimal(request.data.get("cash") or 0, "cash")
            credit = _decimal(request.data.get("credit") or 0, "credit")
            fee = _decimal(request.data.get("card_fee") or 0, "card_fee")
            # Clerk edited the balance (like at check-in): difference is stored as an adjustment.
            try:
                adj = Decimal(str(request.data.get("adjustment_change") or 0)).quantize(Decimal("0.01"))
            except Exception:
                raise ValidationError({"balance": "Enter a valid balance."})
            if cash + credit <= 0 and adj == 0:
                raise ValidationError({"amount": "Enter a cash or card amount."})
            if stay.total_amount + fee + adj < 0:
                raise ValidationError({"balance": "Total cannot go below zero."})
            if fee > 0 and credit <= 0:
                raise ValidationError({"card_fee": "Card fee needs a card amount."})
            notes = (request.data.get("notes") or "").strip()[:255]
            now = timezone.now()
            with transaction.atomic():
                if fee > 0 or adj != 0:
                    stay.card_fee = (stay.card_fee or ZERO) + fee
                    stay.adjustment = (stay.adjustment or ZERO) + adj
                    if adj != 0:
                        word = "Discount" if adj < 0 else "Extra charge"
                        stay.comments = (stay.comments + "\n" if stay.comments else "") + \
                            f"{word} of {abs(adj)} added when taking a balance payment."
                    stay.save()
                for amt, method in ((cash, Payment.CASH), (credit, Payment.CREDIT)):
                    if amt > 0:
                        Payment.objects.create(stay=stay, amount=amt, method=method, paid_at=now,
                                               clerk=request.user, notes=notes)
        else:
            ser = PaymentSerializer(data=request.data)
            ser.is_valid(raise_exception=True)
            ser.save(stay=stay, clerk=request.user, paid_at=timezone.now())
        stay = stay_qs(request.user.client).get(pk=stay.pk)
        return Response(StaySerializer(stay).data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=["post"])
    def checkout(self, request, pk=None):
        """Normal checkout. Optional late_fee (e.g. guest left after the checkout time)."""
        stay = self.get_object()
        if stay.status != Stay.CHECKED_IN:
            raise ValidationError({"detail": "This guest is already checked out."})
        if request.data.get("late_fee") not in (None, ""):
            fee = _decimal(request.data.get("late_fee"), "late_fee")
            stay.late_fee = fee
        stay.status = Stay.CHECKED_OUT
        stay.checked_out_at = timezone.now()
        stay.save()
        stay = stay_qs(request.user.client).get(pk=stay.pk)
        return Response(StaySerializer(stay).data)

    def _early_args(self, stay, data):
        if stay.status != Stay.CHECKED_IN:
            raise ValidationError({"detail": "Only a checked-in guest can check out early."})
        biz = business.business_date(stay.client)
        today = max(timezone.localdate(), biz)
        depart = parse_date(data.get("date"), today, "date")
        if depart < stay.check_in_date:
            raise ValidationError({"date": "Departure cannot be before the check-in date."})
        if depart > today:
            raise ValidationError({"date": "Departure cannot be in the future."})
        if depart >= stay.check_out_date:
            raise ValidationError({"date": f"Guest is not leaving early. Booked checkout is "
                                           f"{stay.check_out_date:%m/%d/%Y}; use normal checkout."})
        method = data.get("method") or early.DAILY_RATE
        if method not in early.METHODS:
            raise ValidationError({"method": f"Use one of {', '.join(early.METHODS)}."})
        custom = None
        if method == early.CUSTOM:
            if data.get("room_charge") in (None, ""):
                raise ValidationError({"room_charge": "Enter the room charge for the nights used."})
            custom = _decimal(data.get("room_charge"), "room_charge")
        return depart, method, custom

    @action(detail=True, methods=["get"])
    def early_quote(self, request, pk=None):
        """Preview an early checkout: new total, refund due or balance still owed."""
        stay = self.get_object()
        depart, method, custom = self._early_args(stay, request.query_params)
        return Response(early.quote(stay, depart, method, custom))

    @action(detail=True, methods=["post"])
    def early_checkout(self, request, pk=None):
        """
        Check a guest out before the booked date and (optionally) refund the difference.
        Body: date, method, room_charge (CUSTOM only), refund_amount (default = full refund due),
              refund_method CASH | CREDIT, notes.
        """
        stay = self.get_object()
        depart, method, custom = self._early_args(stay, request.data)
        qt = early.quote(stay, depart, method, custom)
        due = Decimal(qt["refund_due"])
        raw = request.data.get("refund_amount")
        refund = due if raw in (None, "") else _decimal(raw, "refund_amount")
        if refund > due:
            raise ValidationError({"refund_amount": f"Refund cannot be more than {due}."})
        refund_method = request.data.get("refund_method") or Payment.CASH
        if refund > 0 and refund_method not in (Payment.CASH, Payment.CREDIT):
            raise ValidationError({"refund_method": "Use CASH or CREDIT."})
        notes = (request.data.get("notes") or "").strip()[:200]

        with transaction.atomic():
            stay.early_snapshot = {
                "check_out_date": stay.check_out_date.isoformat(),
                "nights": stay.num_days,
                "periods": stay.periods,
                "room_charge": str(stay.room_charge),
                "room_charge_override": None if stay.room_charge_override is None else str(stay.room_charge_override),
                "extra_person_fee": str(stay.extra_person_fee or 0),
                "total": str(stay.total_amount),
                "method": method,
            }
            stay.check_out_date = depart
            stay.room_charge_override = Decimal(qt["room_charge"])
            stay.extra_person_fee = Decimal(qt["extra_person_fee"])
            stay.status = Stay.CHECKED_OUT
            stay.checked_out_at = timezone.now()
            line = (f"Early checkout on {depart:%m/%d/%Y} (booked to {qt['original_check_out_date']:%m/%d/%Y}), "
                    f"{qt['nights_used']} of {qt['nights_booked']} nights, {METHOD_LABELS[method]}. "
                    f"Total {qt['original_total']} -> {qt['new_total']}.")
            if refund > 0:
                line += f" Refunded {refund} {refund_method.lower()}."
            if notes:
                line += f" {notes}"
            stay.comments = (stay.comments + "\n" if stay.comments else "") + line
            stay.save()
            if refund > 0:
                Payment.objects.create(
                    stay=stay, amount=-refund, method=refund_method, kind=Payment.REFUND,
                    paid_at=timezone.now(), clerk=request.user, notes=notes or "Early checkout refund",
                )
        stay = stay_qs(request.user.client).get(pk=stay.pk)
        return Response(StaySerializer(stay).data)

    @action(detail=True, methods=["post"])
    def extend(self, request, pk=None):
        """
        Add stay: guest stays longer (usually paying in advance). Same entry, same rate.
        Body: periods (nights / weeks / months by the stay's rent type), cash, credit, card_fee, notes,
              allow_overlap (rent anyway if the room is booked after the current checkout).
        """
        stay = self.get_object()
        if stay.status != Stay.CHECKED_IN:
            raise ValidationError({"detail": "Only a guest who is in house can add stay."})
        try:
            n = int(request.data.get("periods") or 0)
        except (TypeError, ValueError):
            n = 0
        if n < 1 or n > 366:
            raise ValidationError({"periods": "Enter how many to add (1 or more)."})
        old_out = stay.check_out_date
        if stay.rate_type == Stay.WEEKLY:
            new_out = old_out + datetime.timedelta(days=7 * n)
        elif stay.rate_type == Stay.MONTHLY:
            m = old_out.month - 1 + n
            y, m = old_out.year + m // 12, m % 12 + 1
            import calendar
            new_out = old_out.replace(year=y, month=m, day=min(old_out.day, calendar.monthrange(y, m)[1]))
        else:
            new_out = old_out + datetime.timedelta(days=n)
        added_nights = (new_out - old_out).days

        other = (Stay.objects.filter(room=stay.room, is_deleted=False, status=Stay.CHECKED_IN,
                                     check_in_date__lt=new_out, check_out_date__gt=old_out)
                 .exclude(pk=stay.pk).select_related("guest").first())
        if other and request.data.get("allow_overlap") not in (True, "true", "1", 1):
            raise ValidationError({"overlap": f"Room {stay.room.number} is booked for {other.guest.name} "
                                              f"from {other.check_in_date:%m/%d/%Y}. Add stay anyway?"})

        cash = _decimal(request.data.get("cash") or 0, "cash")
        credit = _decimal(request.data.get("credit") or 0, "credit")
        fee = _decimal(request.data.get("card_fee") or 0, "card_fee")
        if fee > 0 and credit <= 0:
            raise ValidationError({"card_fee": "Card fee needs a card amount."})
        notes = (request.data.get("notes") or "").strip()[:255]
        unit = {Stay.DAILY: "night", Stay.WEEKLY: "week", Stay.MONTHLY: "month"}[stay.rate_type]

        with transaction.atomic():
            # extra person fee is per night: add the same nightly amount for the new nights
            if stay.extra_person_fee and stay.num_days:
                per_night = Decimal(stay.extra_person_fee) / stay.num_days
                stay.extra_person_fee = (Decimal(stay.extra_person_fee) + per_night * added_nights).quantize(Decimal("0.01"))
            if stay.rate_type != Stay.DAILY:
                stay.periods = stay.periods + n
            stay.check_out_date = new_out
            stay.card_fee = (stay.card_fee or ZERO) + fee
            stay.comments = (stay.comments + "\n" if stay.comments else "") + (
                f"Stay added: {n} {unit}{'s' if n > 1 else ''}, checkout {old_out:%m/%d/%Y} -> {new_out:%m/%d/%Y}.")
            stay.save()
            now = timezone.now()
            for amt, method in ((cash, Payment.CASH), (credit, Payment.CREDIT)):
                if amt > 0:
                    Payment.objects.create(stay=stay, amount=amt, method=method, paid_at=now, clerk=request.user,
                                           notes=notes or f"Advance for added stay to {new_out:%m/%d/%Y}")
        stay = stay_qs(request.user.client).get(pk=stay.pk)
        return Response(StaySerializer(stay).data)

    @action(detail=True, methods=["post"])
    def refund(self, request, pk=None):
        """Give money back to a guest who has paid more than the total (balance below zero)."""
        stay = self.get_object()
        amount = _decimal(request.data.get("amount"), "amount")
        if amount <= 0:
            raise ValidationError({"amount": "Amount must be greater than zero."})
        over = paid(stay) - stay.total_amount
        if over <= 0:
            raise ValidationError({"amount": "Guest has not overpaid. Nothing to refund."})
        if amount > over:
            raise ValidationError({"amount": f"Refund cannot be more than the overpaid amount {over}."})
        method = request.data.get("method") or Payment.CASH
        if method not in (Payment.CASH, Payment.CREDIT):
            raise ValidationError({"method": "Use CASH or CREDIT."})
        Payment.objects.create(
            stay=stay, amount=-amount, method=method, kind=Payment.REFUND, paid_at=timezone.now(),
            clerk=request.user, notes=(request.data.get("notes") or "Refund").strip()[:255],
        )
        stay = stay_qs(request.user.client).get(pk=stay.pk)
        return Response(StaySerializer(stay).data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=["post"])
    def reopen(self, request, pk=None):
        """Undo checkout. An early checkout is reversed too (booked dates and charges come back)."""
        stay = self.get_object()
        if stay.status != Stay.CHECKED_OUT:
            raise ValidationError({"detail": "This guest is not checked out."})
        snap = stay.early_snapshot
        if snap:
            orig_out = datetime.date.fromisoformat(snap["check_out_date"])
            end = orig_out if orig_out > stay.check_in_date else stay.check_in_date + datetime.timedelta(days=1)
            other = (Stay.objects.filter(room=stay.room, is_deleted=False, status=Stay.CHECKED_IN,
                                         check_in_date__lt=end, check_out_date__gt=stay.check_in_date)
                     .exclude(pk=stay.pk).select_related("guest").first())
            if other and request.data.get("force") not in (True, "true", "1", 1):
                raise ValidationError({"overlap": f"Room {stay.room.number} has been rented to {other.guest.name} "
                                                  f"since the early checkout. Undo anyway?"})
            with transaction.atomic():
                stay.check_out_date = orig_out
                stay.periods = int(snap.get("periods") or stay.periods)
                o = snap.get("room_charge_override")
                stay.room_charge_override = None if o in (None, "") else Decimal(o)
                stay.extra_person_fee = Decimal(snap.get("extra_person_fee") or 0)
                stay.early_snapshot = None
                stay.status = Stay.CHECKED_IN
                stay.checked_out_at = None
                stay.comments = (stay.comments + "\n" if stay.comments else "") + \
                    f"Early checkout undone; booked to {orig_out:%m/%d/%Y} again. Refunds already given stay on record."
                stay.save()
        else:
            stay.status = Stay.CHECKED_IN
            stay.checked_out_at = None
            stay.save()
        stay = stay_qs(request.user.client).get(pk=stay.pk)
        return Response(StaySerializer(stay).data)


METHOD_LABELS = {
    early.DAILY_RATE: "charged at daily rate",
    early.PRORATA: "charged pro-rata",
    early.NO_REFUND: "full charge kept",
    early.CUSTOM: "custom room charge",
}


def _decimal(value, field):
    try:
        v = Decimal(str(value)).quantize(Decimal("0.01"))
    except Exception:
        raise ValidationError({field: "Enter a valid amount."})
    if v < 0:
        raise ValidationError({field: "Cannot be negative."})
    return v


# ------------------------------------------------------------------ dashboard
@api_view(["GET"])
@permission_classes([IsClientStaff])
def dashboard(request):
    """Home page: checkouts due on the date, everyone staying that date, quick stats."""
    client = request.user.client
    day = parse_date(request.query_params.get("date"), business.business_date(client))
    base = stay_qs(client).filter(is_deleted=False)
    staying = list(base.filter(check_in_date__lte=day, check_out_date__gte=day).order_by("room__number"))
    checkouts = [s for s in staying if s.check_out_date == day]
    arrivals = [s for s in staying if s.check_in_date == day]
    occupied = occupying_on(staying, day)
    occupied_ids = {s.room_id for s in occupied}
    due_out_ids = {s.room_id for s in checkouts if s.status == Stay.CHECKED_IN}
    total_rooms = Room.objects.filter(client=client, is_active=True).count()
    open_balances = [s for s in base.filter(check_in_date__lte=day) if s.total_amount - paid(s) > 0]

    return Response({
        "date": day,
        "stats": {
            "total_rooms": total_rooms,
            "occupied": len({s.room_id for s in occupied}),
            "available": max(total_rooms - len({s.room_id for s in occupied}), 0),
            "checkouts_due": len([s for s in checkouts if s.status == Stay.CHECKED_IN]),
            "checked_out": len([s for s in checkouts if s.status == Stay.CHECKED_OUT]),
            "arrivals": len(arrivals),
            "open_balance_count": len(open_balances),
            "open_balance_total": str(sum((s.total_amount - paid(s) for s in open_balances), ZERO)),
            "notes": Note.objects.filter(client=client, date=day).count(),
        },
        "checkouts": StaySerializer(checkouts, many=True).data,
        "staying": StaySerializer(staying, many=True).data,
        # every active room, so the Room sheet can show empty rows for vacant rooms
        # available = free for the night of this date; due_out = guest leaving today, not checked out yet
        "rooms": [
            {"id": r.id, "number": r.number, "room_type": r.room_type.name,
             "default_rate": str(r.room_type.default_rate),
             "weekly_rate": str(r.room_type.weekly_rate), "monthly_rate": str(r.room_type.monthly_rate),
             "available": r.id not in occupied_ids,
             "due_out": r.id in due_out_ids}
            for r in Room.objects.filter(client=client, is_active=True).select_related("room_type")
        ],
    })


# ------------------------------------------------------------------ reports
def _date_range(request, max_days=93, client=None):
    today = business.business_date(client)
    start = parse_date(request.query_params.get("start"), today, "start")
    end = parse_date(request.query_params.get("end"), start, "end")
    if end < start:
        raise ValidationError({"end": "End date is before start date."})
    if (end - start).days > max_days:
        raise ValidationError({"end": f"Range cannot exceed {max_days} days."})
    return start, end


@api_view(["GET"])
@permission_classes([IsClientStaffOrSuperAdmin])
def report_checkins(request):
    """Daily check-ins. Includes every payment on the stay, including later balance payments."""
    client = get_request_client(request)
    start, end = _date_range(request, client=client)
    stays = stay_qs(client).filter(is_deleted=False, check_in_date__range=(start, end)).order_by("check_in_date", "room__number")
    rows, totals = [], {"total": ZERO, "cash": ZERO, "credit": ZERO, "paid_later": ZERO, "paid": ZERO, "balance": ZERO}
    for s in stays:
        # cash / credit = taken on the check-in day; money taken on later days counts on those days
        cash, credit = paid_on(s, s.check_in_date, Payment.CASH), paid_on(s, s.check_in_date, Payment.CREDIT)
        all_paid = paid(s)
        later = all_paid - cash - credit
        bal = s.total_amount - all_paid
        rows.append({
            "id": s.id, "check_in_date": s.check_in_date, "room_number": s.room.number,
            "room_type": s.room.room_type.name, "guest_name": s.guest.name,
            "num_guests": s.num_guests, "num_days": s.num_days, "rate": str(s.rate),
            "rate_type": s.rate_type, "periods": s.periods, "fees": str(s.charges_total),
            "total": str(s.total_amount), "cash": str(cash), "credit": str(credit),
            "paid_later": str(later), "paid": str(all_paid), "balance": str(bal),
            "clerk": (s.clerk.get_full_name() or s.clerk.username) if s.clerk else "",
            "status": s.status,
        })
        totals["total"] += s.total_amount
        totals["cash"] += cash
        totals["credit"] += credit
        totals["paid_later"] += later
        totals["paid"] += all_paid
        totals["balance"] += bal
    return Response({
        "start": start, "end": end, "count": len(rows), "rows": rows,
        "totals": {k: str(v) for k, v in totals.items()},
    })


@api_view(["GET"])
@permission_classes([IsClientStaffOrSuperAdmin])
def report_collections(request):
    """Money actually collected per day (by payment date), cash vs credit, net of refunds given."""
    client = get_request_client(request)
    start, end = _date_range(request, client=client)
    pays = (
        Payment.objects.filter(stay__client=client, stay__is_deleted=False, business_date__range=(start, end))
        .select_related("stay", "stay__guest", "stay__room", "clerk").order_by("paid_at")
    )
    by_day, detail = {}, []
    totals = {"cash": ZERO, "credit": ZERO, "refunds": ZERO, "total": ZERO}
    for p in pays:
        d = p.business_date
        row = by_day.setdefault(d, {"date": d, "cash": ZERO, "credit": ZERO, "refunds": ZERO, "total": ZERO, "count": 0})
        if p.kind == Payment.REFUND:
            row["refunds"] += -p.amount
            totals["refunds"] += -p.amount
        key = "cash" if p.method == Payment.CASH else "credit"
        row[key] += p.amount
        row["total"] += p.amount
        row["count"] += 1
        totals[key] += p.amount
        totals["total"] += p.amount
        detail.append({
            "id": p.id, "paid_at": p.paid_at, "business_date": p.business_date, "method": p.method, "amount": str(p.amount),
            "type": pay_type(p),
            "guest_name": p.stay.guest.name, "room_number": p.stay.room.number,
            "check_in_date": p.stay.check_in_date,
            "clerk": (p.clerk.get_full_name() or p.clerk.username) if p.clerk else "",
        })
    days = [{**r, "cash": str(r["cash"]), "credit": str(r["credit"]), "refunds": str(r["refunds"]), "total": str(r["total"])}
            for r in sorted(by_day.values(), key=lambda r: r["date"])]
    return Response({
        "start": start, "end": end, "days": days, "payments": detail,
        "totals": {k: str(v) for k, v in totals.items()},
    })


@api_view(["GET"])
@permission_classes([IsClientStaffOrSuperAdmin])
def report_outstanding(request):
    """Every stay that still owes money."""
    client = get_request_client(request)
    rows, total = [], ZERO
    for s in stay_qs(client).filter(is_deleted=False).order_by("check_in_date"):
        bal = s.total_amount - paid(s)
        if bal <= 0:
            continue
        total += bal
        rows.append({
            "id": s.id, "check_in_date": s.check_in_date, "check_out_date": s.check_out_date,
            "room_number": s.room.number, "guest_name": s.guest.name, "phone": s.guest.phone,
            "total": str(s.total_amount), "paid": str(paid(s)), "balance": str(bal), "status": s.status,
        })
    return Response({"count": len(rows), "total_balance": str(total), "rows": rows})


@api_view(["GET"])
@permission_classes([IsClientStaffOrSuperAdmin])
def report_occupancy(request):
    """Occupied rooms per night, and by room type."""
    client = get_request_client(request)
    start, end = _date_range(request, client=client)
    rooms = list(Room.objects.filter(client=client, is_active=True).select_related("room_type"))
    total_rooms = len(rooms)
    type_totals = {}
    for r in rooms:
        type_totals[r.room_type.name] = type_totals.get(r.room_type.name, 0) + 1
    stays = list(stay_qs(client).filter(is_deleted=False, check_in_date__lte=end, check_out_date__gte=start))

    days, type_nights = [], {k: 0 for k in type_totals}
    d = start
    while d <= end:
        occ = occupying_on(stays, d)
        room_ids = {s.room_id for s in occ}
        for s in occ:
            name = s.room.room_type.name
            if name in type_nights:
                type_nights[name] += 1
        revenue = sum((s.nightly_value for s in occ), ZERO)
        days.append({
            "date": d, "occupied": len(room_ids), "available": max(total_rooms - len(room_ids), 0),
            "total_rooms": total_rooms,
            "occupancy_pct": round(len(room_ids) * 100 / total_rooms, 1) if total_rooms else 0,
            "room_revenue": str(revenue),
            "adr": str((revenue / len(occ)).quantize(Decimal("0.01"))) if occ else "0.00",
        })
        d += datetime.timedelta(days=1)

    n_days = len(days)
    by_type = [{
        "room_type": name, "rooms": cnt, "room_nights": type_nights[name],
        "occupancy_pct": round(type_nights[name] * 100 / (cnt * n_days), 1) if cnt and n_days else 0,
    } for name, cnt in sorted(type_totals.items())]
    occupied_nights = sum(x["occupied"] for x in days)
    return Response({
        "start": start, "end": end, "days": days, "by_type": by_type,
        "summary": {
            "total_rooms": total_rooms, "room_nights_sold": occupied_nights,
            "occupancy_pct": round(occupied_nights * 100 / (total_rooms * n_days), 1) if total_rooms and n_days else 0,
        },
    })


@api_view(["GET"])
@permission_classes([IsClientStaff])
def report_today(request):
    """
    Today's Report: end-of-day / shift handover summary for the front desk.
    ?date=YYYY-MM-DD (default today)   ?mine=1 limits to the logged-in clerk's entries.
    """
    client = request.user.client
    day = parse_date(request.query_params.get("date"), business.business_date(client))
    mine = request.query_params.get("mine") == "1"

    def clerk_name(u):
        return (u.get_full_name() or u.username) if u else ""

    base = stay_qs(client).filter(is_deleted=False)

    # check-ins made for this date
    checkins = list(base.filter(check_in_date=day).order_by("check_in_time"))
    if mine:
        checkins = [s for s in checkins if s.clerk_id == request.user.id]

    # checkouts due / done on this date
    checkouts = list(base.filter(check_out_date=day).exclude(check_in_date=day).order_by("room__number"))
    checkouts += [s for s in base.filter(check_out_date=day, check_in_date=day) if s.status == Stay.CHECKED_OUT]

    # money received on this date (by payment time)
    pays = list(
        Payment.objects.filter(stay__client=client, stay__is_deleted=False, business_date=day)
        .select_related("stay", "stay__guest", "stay__room", "clerk").order_by("paid_at")
    )
    if mine:
        pays = [p for p in pays if p.clerk_id == request.user.id]

    cash = sum((p.amount for p in pays if p.method == Payment.CASH), ZERO)
    credit = sum((p.amount for p in pays if p.method == Payment.CREDIT), ZERO)
    from_checkins = sum((p.amount for p in pays if p.stay.check_in_date == day), ZERO)
    refunds = sum((-p.amount for p in pays if p.kind == Payment.REFUND), ZERO)

    by_clerk = {}
    for p in pays:
        row = by_clerk.setdefault(clerk_name(p.clerk) or "Unknown", {"cash": ZERO, "credit": ZERO, "count": 0})
        row["cash" if p.method == Payment.CASH else "credit"] += p.amount
        row["count"] += 1

    # occupancy tonight
    total_rooms = Room.objects.filter(client=client, is_active=True).count()
    staying = list(base.filter(check_in_date__lte=day, check_out_date__gte=day))
    occupied = len({s.room_id for s in occupying_on(staying, day)})

    checkin_rows, booked, owed = [], ZERO, ZERO
    for s in checkins:
        c, cr = paid_on(s, day, Payment.CASH), paid_on(s, day, Payment.CREDIT)
        other = paid(s) - c - cr   # taken on other days (counted on those days)
        bal = s.total_amount - paid(s)
        booked += s.total_amount
        owed += max(bal, ZERO)
        checkin_rows.append({
            "id": s.id, "time": s.check_in_time, "room_number": s.room.number, "room_type": s.room.room_type.name,
            "guest_name": s.guest.name, "num_guests": s.num_guests, "num_days": s.num_days,
            "check_out_date": s.check_out_date, "rate": str(s.rate), "total": str(s.total_amount),
            "rate_type": s.rate_type, "periods": s.periods,
            "cash": str(c), "credit": str(cr), "paid_other_days": str(other),
            "balance": str(bal), "clerk": clerk_name(s.clerk),
            "do_not_rent": s.guest.do_not_rent,
        })

    return Response({
        "date": day,
        "mine": mine,
        "summary": {
            "checkins": len(checkins),
            "checkouts_due": len([s for s in checkouts if s.status == Stay.CHECKED_IN]),
            "checkouts_done": len([s for s in checkouts if s.status == Stay.CHECKED_OUT]),
            "occupied": occupied,
            "available": max(total_rooms - occupied, 0),
            "total_rooms": total_rooms,
            "occupancy_pct": round(occupied * 100 / total_rooms, 1) if total_rooms else 0,
        },
        "money": {
            "booked": str(booked),
            "cash": str(cash),
            "credit": str(credit),
            "collected": str(cash + credit),
            "refunds": str(refunds),
            "received": str(cash + credit + refunds),
            "from_todays_checkins": str(from_checkins),
            "from_earlier_stays": str(cash + credit - from_checkins),
            "unpaid_from_todays_checkins": str(owed),
        },
        "by_clerk": [
            {"clerk": k, "cash": str(v["cash"]), "credit": str(v["credit"]),
             "total": str(v["cash"] + v["credit"]), "count": v["count"]}
            for k, v in sorted(by_clerk.items())
        ],
        "checkins": checkin_rows,
        "checkouts": [{
            "id": s.id, "room_number": s.room.number, "guest_name": s.guest.name,
            "check_in_date": s.check_in_date, "total": str(s.total_amount),
            "balance": str(s.total_amount - paid(s)), "status": s.status,
        } for s in checkouts],
        "payments": [{
            "id": p.id, "paid_at": p.paid_at, "business_date": p.business_date, "method": p.method, "amount": str(p.amount),
            "type": pay_type(p),
            "guest_name": p.stay.guest.name, "room_number": p.stay.room.number,
            "stay_id": p.stay_id, "check_in_date": p.stay.check_in_date, "clerk": clerk_name(p.clerk),
        } for p in pays],
    })


# ------------------------------------------------------------------ maintenance
class NoteViewSet(viewsets.ModelViewSet):
    """
    Maintenance notes, written by front desk staff (client admin / client user).
    ?date=YYYY-MM-DD filters by day. Users can edit or delete their own notes; the admin can edit any.
    """

    permission_classes = [IsClientStaff]
    serializer_class = NoteSerializer

    def get_queryset(self):
        qs = Note.objects.filter(client=self.request.user.client).select_related("room", "created_by")
        if self.request.query_params.get("date"):
            qs = qs.filter(date=parse_date(self.request.query_params["date"]))
        return qs

    def perform_create(self, serializer):
        serializer.save(client=self.request.user.client, created_by=self.request.user)

    def _check_owner(self, note):
        u = self.request.user
        if u.role != User.CLIENT_ADMIN and note.created_by_id != u.id:
            raise PermissionDenied("You can only change your own notes.")

    def perform_update(self, serializer):
        self._check_owner(serializer.instance)
        serializer.save()

    def perform_destroy(self, instance):
        self._check_owner(instance)
        instance.delete()


@api_view(["GET"])
@permission_classes([IsMaintenanceOrStaff])
def maintenance_board(request):
    """
    What the maintenance user sees: rooms checking out on the date and that day's notes.
    No guest details or money are sent.
    """
    client = request.user.client
    day = parse_date(request.query_params.get("date"), business.business_date(client))
    stays = (
        Stay.objects.filter(client=client, is_deleted=False, check_out_date=day)
        .select_related("room", "room__room_type").order_by("room__number")
    )
    notes = list(Note.objects.filter(client=client, date=day).select_related("room", "created_by"))
    notes_by_room = {}
    for n in notes:
        notes_by_room.setdefault(n.room_id, []).append(n)

    def note_json(n):
        return {
            "id": n.id, "text": n.text, "room_number": n.room.number if n.room else None,
            "created_by": (n.created_by.get_full_name() or n.created_by.username) if n.created_by else "",
            "created_at": n.created_at,
        }

    rooms, seen = [], set()
    for s in stays:
        if s.room_id in seen:
            continue  # same room rented twice: one card is enough
        seen.add(s.room_id)
        same_room = [x for x in stays if x.room_id == s.room_id]
        left = all(x.status == Stay.CHECKED_OUT for x in same_room)
        rooms.append({
            "room_id": s.room_id, "room_number": s.room.number, "room_type": s.room.room_type.name,
            "check_out_time": s.check_out_time,
            "guest_left": left,
            "checked_out_at": max((x.checked_out_at for x in same_room if x.checked_out_at), default=None),
            "notes": [note_json(n) for n in notes_by_room.get(s.room_id, [])],
        })
    rooms.sort(key=lambda r: (r["guest_left"] is False, r["room_number"]))
    other_notes = [note_json(n) for n in notes if n.room_id not in seen]

    return Response({
        "date": day,
        "summary": {
            "checkouts": len(rooms),
            "ready": sum(1 for r in rooms if r["guest_left"]),
            "waiting": sum(1 for r in rooms if not r["guest_left"]),
            "notes": len(notes),
        },
        "rooms": rooms,
        "other_notes": other_notes,
    })


# ------------------------------------------------------------------ night audit (close the business day)
def day_summary(client, day):
    """Totals for one business day, saved with the Night Audit."""
    base = stay_qs(client).filter(is_deleted=False)
    pays = list(Payment.objects.filter(stay__client=client, stay__is_deleted=False, business_date=day))
    cash = sum((p.amount for p in pays if p.method == Payment.CASH), ZERO)
    credit = sum((p.amount for p in pays if p.method == Payment.CREDIT), ZERO)
    refunds = sum((-p.amount for p in pays if p.kind == Payment.REFUND), ZERO)
    staying = list(base.filter(check_in_date__lte=day, check_out_date__gte=day))
    total_rooms = Room.objects.filter(client=client, is_active=True).count()
    occupied = len({s.room_id for s in occupying_on(staying, day)})
    due_out = [s for s in staying if s.check_out_date == day and s.check_in_date != day and s.status == Stay.CHECKED_IN]
    arrivals = [s for s in staying if s.check_in_date == day]
    unpaid = [s for s in arrivals if s.total_amount - paid(s) > 0]
    return {
        "date": day.isoformat(),
        "checkins": len(arrivals),
        "checkouts_done": len([s for s in staying if s.check_out_date == day and s.status == Stay.CHECKED_OUT]),
        "still_due_out": len(due_out),
        "still_due_out_rooms": [s.room.number for s in due_out],
        "unpaid_checkins": len(unpaid),
        "unpaid_amount": str(sum((s.total_amount - paid(s) for s in unpaid), ZERO)),
        "occupied": occupied,
        "total_rooms": total_rooms,
        "payments": len(pays),
        "cash": str(cash),
        "credit": str(credit),
        "refunds": str(refunds),
        "collected": str(cash + credit),
    }


def _close_row(c):
    return {
        "date": c.date, "closed_at": c.closed_at,
        "closed_by": (c.closed_by.get_full_name() or c.closed_by.username) if c.closed_by else "",
        "summary": c.summary,
    }


def _business_state(client):
    biz = business.business_date(client)
    last = business.last_close(client)
    now = timezone.localtime()
    return {
        "business_date": biz,
        "calendar_date": now.date(),
        "now": now,
        "day_change_time": client.day_change_time.strftime("%H:%M"),
        # a day can be closed once its calendar day has started (no closing tomorrow in advance)
        "can_close": biz <= now.date(),
        "last_close": _close_row(last) if last else None,
    }


@api_view(["GET"])
@permission_classes([IsMaintenanceOrStaff])
def business_day(request):
    """Current business day, used as 'today' everywhere in the app."""
    return Response(_business_state(request.user.client))


@api_view(["GET"])
@permission_classes([IsClientStaff])
def business_day_preview(request):
    client = request.user.client
    biz = business.business_date(client)
    return Response({**_business_state(client), "summary": day_summary(client, biz)})


@api_view(["POST"])
@permission_classes([IsClientStaff])
def business_day_close(request):
    """
    Night Audit: close the current business day. The next day starts right away,
    so new check-ins and payments count on the next day.
    Body: {"date": "YYYY-MM-DD"} must match the current business day (stops double clicks / stale screens).
    """
    client = request.user.client
    with transaction.atomic():
        # lock the motel row so two desks cannot close the same day twice
        type(client).objects.select_for_update().get(pk=client.pk)
        biz = business.business_date(client)
        asked = parse_date(request.data.get("date"), biz)
        if asked != biz:
            raise ValidationError({"date": f"Business day is {biz:%m/%d/%Y}. Refresh the page and try again."})
        if biz > timezone.localdate():
            raise ValidationError({"date": f"{biz:%m/%d/%Y} has not started yet, so it cannot be closed."})
        DayClose.objects.create(client=client, date=biz, closed_at=timezone.now(), closed_by=request.user,
                                summary=day_summary(client, biz))
    return Response(_business_state(client), status=status.HTTP_201_CREATED)


@api_view(["POST"])
@permission_classes([IsClientStaff])
def business_day_reopen(request):
    """Client admin: undo the last Night Audit (e.g. pressed by mistake)."""
    if request.user.role != User.CLIENT_ADMIN:
        raise PermissionDenied("Only the client admin can reopen a closed day.")
    client = request.user.client
    last = business.last_close(client)
    if not last:
        raise ValidationError({"detail": "No closed day to reopen."})
    moved = Payment.objects.filter(stay__client=client, business_date__gt=last.date).count()
    last.delete()
    state = _business_state(client)
    state["note"] = (f"{moved} payment(s) taken after the close stay on the day they were taken."
                     if moved else "")
    return Response(state)


@api_view(["GET"])
@permission_classes([IsClientStaff])
def business_day_history(request):
    closes = DayClose.objects.filter(client=request.user.client).select_related("closed_by")[:60]
    return Response([_close_row(c) for c in closes])
