import datetime
from decimal import Decimal

from django.db import transaction
from django.db.models import F, Q, Sum
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
from .models import CustomReport, DayClose, Expense, RoomIssue, RoomStatusLog, Guest, Photo, PhotoSession, delete_photo_file, place_photo, Note, Payment, Room, RoomType, Stay
from .serializers import (
    CustomReportSerializer, ExpenseSerializer, RoomIssueSerializer, GuestSerializer, NoteSerializer, PaymentSerializer, PhotoSerializer, RoomSerializer, RoomTypeSerializer,
    StaySerializer, StayWriteSerializer, expense_editable,
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
    if p.kind == Payment.STAYOVER:
        return "Stay-over payment"
    return "Check-in" if p.is_initial else "Balance payment"


METHODS = (Payment.CASH, Payment.CREDIT, Payment.CHECK)
METHOD_KEY = {Payment.CASH: "cash", Payment.CREDIT: "credit", Payment.CHECK: "check"}
METHOD_LABEL = {Payment.CASH: "Cash", Payment.CREDIT: "Credit", Payment.CHECK: "Check"}


def _pay_amounts(data):
    """Money handed over in one go: [(method, amount)] for cash, card and check."""
    return [(m, _decimal(data.get(METHOD_KEY[m]) or 0, METHOD_KEY[m])) for m in METHODS]


def _by_method(pays, method, skip_refunds=False):
    return sum((p.amount for p in pays if p.method == method and not (skip_refunds and p.kind == Payment.REFUND)), ZERO)


def _move_carried_back(stay, sign):
    """A stay that brought an old balance with it is deleted (+1) / recovered (-1): the old stay owes it again / not."""
    amt = Decimal(stay.balance_carried or 0)
    if amt > 0 and stay.renewed_from_id:
        old = Stay.objects.filter(pk=stay.renewed_from_id).first()
        if old:
            old.balance_carried = Decimal(old.balance_carried or 0) + sign * amt
            old.save()


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
        issues = _open_issue_counts(client)
        data = []
        for r in rooms:
            s = by_room.get(r.id)
            data.append({
                "hk_status": r.hk_status, "hk_note": r.hk_note, "open_issues": issues.get(r.id, 0),
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


def find_dnr(client, name="", phone="", plate="", dl=""):
    """
    Do Not Rent guests matching any of name / phone / plate.
    Phone compares digits only (806-555-0111 = (806) 555 0111), plate ignores spaces and dashes,
    name matches the full name, ignoring case.
    Returns [(guest, [reasons])].
    """
    name = (name or "").strip().lower()
    phone_d = _digits(phone)
    plate_n = _plate(plate)
    dl_n = _plate(dl)
    out = []
    for g in Guest.objects.filter(client=client, do_not_rent=True, is_deleted=False).select_related("dnr_marked_by"):
        why = []
        if phone_d and len(phone_d) >= 7 and _digits(g.phone) and (
            _digits(g.phone).endswith(phone_d[-10:]) or phone_d.endswith(_digits(g.phone)[-10:])
        ):
            why.append("phone")
        if plate_n and len(plate_n) >= 3 and _plate(g.license_plate) == plate_n:
            why.append("plate")
        if dl_n and len(dl_n) >= 4 and _plate(g.dl_number) == dl_n:
            why.append("DL")
        if name and len(name) >= 3 and " ".join(g.name.lower().split()) == " ".join(name.split()):
            why.append("name")
        if why:
            out.append((g, why))
    return out


def _attach_guest_photos(guest, photo_ids):
    """DL photos added on the DNR form: kept with the guest (media/DNR/)."""
    for ph in Photo.objects.filter(client=guest.client, id__in=[int(i) for i in (photo_ids or [])],
                                   stay__isnull=True, guest__isnull=True):
        ph.guest = guest
        ph.save(update_fields=["guest"])
        place_photo(ph)


def _with_guest_money(qs):
    """Cash / card paid and total charged over each guest's stays (deleted stays left out), in the database."""
    from django.db.models import DecimalField, OuterRef, Subquery, Value
    from django.db.models.functions import Coalesce
    dec = DecimalField(max_digits=12, decimal_places=2)

    def paid(method):
        sq = (Payment.objects.filter(stay__guest=OuterRef("pk"), stay__is_deleted=False, method=method)
              .values("stay__guest").annotate(t=Sum("amount")).values("t"))
        return Coalesce(Subquery(sq, output_field=dec), Value(ZERO), output_field=dec)
    total_sq = (Stay.objects.filter(guest=OuterRef("pk"), is_deleted=False)
                .values("guest").annotate(t=Sum("total_amount")).values("t"))
    return qs.annotate(ann_cash=paid(Payment.CASH), ann_card=paid(Payment.CREDIT), ann_check=paid(Payment.CHECK),
                       ann_total=Coalesce(Subquery(total_sq, output_field=dec), Value(ZERO), output_field=dec))


class GuestViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, mixins.CreateModelMixin,
                   mixins.UpdateModelMixin, mixins.DestroyModelMixin, viewsets.GenericViewSet):
    """
    Guests. POST adds someone straight to the Do Not Rent list (e.g. past customers);
    if a guest with the same phone or plate already exists, that guest is flagged instead of duplicated.
    """
    permission_classes = [IsClientStaff]
    serializer_class = GuestSerializer

    def get_queryset(self):
        qs = Guest.objects.filter(client=self.request.user.client).select_related("deleted_by", "dnr_marked_by")
        if self.action == "list":
            # ?deleted=1: the admin's list of deleted guests (to recover); otherwise deleted guests are hidden
            if self.request.query_params.get("deleted") == "1":
                if self.request.user.role != User.CLIENT_ADMIN:
                    raise PermissionDenied("Only the client admin can see deleted guests.")
                qs = qs.filter(is_deleted=True)
            else:
                qs = qs.filter(is_deleted=False)
            qs = _with_guest_money(qs)
        q = self.request.query_params.get("q")
        if q:
            qs = qs.filter(Q(name__icontains=q) | Q(phone__icontains=q) | Q(license_plate__icontains=q)
                           | Q(dl_number__icontains=q))
        if self.request.query_params.get("dnr") == "1":
            qs = qs.filter(do_not_rent=True)
        return qs[:200] if self.action == "list" else qs

    def create(self, request, *args, **kwargs):
        client = request.user.client
        ser = self.get_serializer(data=request.data)
        ser.is_valid(raise_exception=True)
        data = ser.validated_data
        existing = None
        live = Guest.objects.filter(client=client, is_deleted=False)
        if data.get("phone") and len(_digits(data["phone"])) >= 7:
            existing = next((g for g in live
                             if _digits(g.phone) and _digits(g.phone)[-10:] == _digits(data["phone"])[-10:]), None)
        if existing is None and _plate(data.get("dl_number")):
            existing = next((g for g in live.exclude(dl_number="")
                             if _plate(g.dl_number) == _plate(data["dl_number"])), None)
        if existing is None and data.get("license_plate"):
            existing = next((g for g in live
                             if _plate(g.license_plate) == _plate(data["license_plate"])), None)
        if existing:
            for k, v in data.items():
                if v not in ("", None) or k in ("do_not_rent",):
                    setattr(existing, k, v)
            if existing.do_not_rent and not existing.dnr_marked_by_id:
                existing.dnr_marked_by = request.user
            existing.save()
            _attach_guest_photos(existing, request.data.get("photo_ids"))
            out = GuestSerializer(existing).data
            out["merged"] = True
            return Response(out, status=status.HTTP_200_OK)
        guest = ser.save(client=client, dnr_marked_by=request.user if data.get("do_not_rent") else None)
        _attach_guest_photos(guest, request.data.get("photo_ids"))
        return Response(GuestSerializer(guest).data, status=status.HTTP_201_CREATED)

    def perform_update(self, serializer):
        was = serializer.instance.do_not_rent
        guest = serializer.save()
        if guest.do_not_rent and not was:
            guest.dnr_marked_by = self.request.user
            guest.save()
        _attach_guest_photos(guest, self.request.data.get("photo_ids"))

    @action(detail=False, methods=["get"])
    def dnr_check(self, request):
        """Check-in form "Check DNR" button: is this name / phone / plate / DL number on the Do Not Rent list?"""
        p = request.query_params
        hits = find_dnr(request.user.client, p.get("name"), p.get("phone"), p.get("plate"), p.get("dl"))
        checked = [k for k in ("name", "phone", "plate", "dl") if (p.get(k) or "").strip()]
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
        dl = (request.query_params.get("dl") or "").strip()
        cond = Q()
        if dl and len(_plate(dl)) >= 4:
            ids = [g.id for g in Guest.objects.filter(client=client, is_deleted=False).exclude(dl_number="") if _plate(g.dl_number) == _plate(dl)]
            cond |= Q(id__in=ids)
        if phone:
            cond |= Q(phone=phone)
        if plate:
            cond |= Q(license_plate__iexact=plate)
        if name and len(name) >= 3:
            cond |= Q(name__iexact=name)
        if not cond:
            return Response([])
        guests = Guest.objects.filter(client=client, is_deleted=False).filter(cond).order_by("-do_not_rent", "-updated_at")[:5]
        return Response(GuestSerializer(guests, many=True).data)

    def destroy(self, request, *args, **kwargs):
        """Guest Directory delete: admin only, soft delete (stays and payments are kept)."""
        if request.user.role != User.CLIENT_ADMIN:
            raise PermissionDenied("Only the client admin can delete guests.")
        guest = self.get_object()
        guest.is_deleted = True
        guest.deleted_at = timezone.now()
        guest.deleted_by = request.user
        guest.save(update_fields=["is_deleted", "deleted_at", "deleted_by", "updated_at"])
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=True, methods=["post"])
    def restore(self, request, pk=None):
        if request.user.role != User.CLIENT_ADMIN:
            raise PermissionDenied("Only the client admin can recover guests.")
        guest = self.get_object()
        guest.is_deleted = False
        guest.deleted_at = None
        guest.deleted_by = None
        guest.save(update_fields=["is_deleted", "deleted_at", "deleted_by", "updated_at"])
        return Response(GuestSerializer(_with_guest_money(Guest.objects.filter(pk=guest.pk)).get()).data)

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
        # grid filter row (Guests / Balance Payments): one box per column
        if p.get("room"):
            qs = qs.filter(room__number__icontains=p["room"].strip())
        if p.get("name"):
            qs = qs.filter(guest__name__icontains=p["name"].strip())
        if p.get("phone"):
            qs = qs.filter(guest__phone__icontains=p["phone"].strip())
        if p.get("days"):
            try:
                qs = qs.filter(num_days=int(p["days"]))
            except ValueError:
                raise ValidationError({"days": "Use a number."})
        if p.get("q"):
            q = p["q"]
            qs = qs.filter(
                Q(guest__name__icontains=q) | Q(guest__phone__icontains=q)
                | Q(guest__license_plate__icontains=q) | Q(guest__dl_number__icontains=q) | Q(room__number__iexact=q)
            )
        return qs

    def list(self, request, *args, **kwargs):
        """
        ?page=N&page_size=25 returns one page: {count, page, page_size, pages, results, owed}.
        Without page: old behaviour (plain list, max 500) for screens that need a short list.
        """
        p = request.query_params
        qs = self.get_queryset().order_by("-check_in_date", "-check_in_time", "-id")
        balance = "owed" if p.get("has_balance") == "1" else (p.get("balance") or "")
        if balance not in ("", "owed", "paid", "credit"):
            raise ValidationError({"balance": "Use owed, paid or credit."})
        if balance:
            # balance = total - payments; worked out in the database so only one page is loaded
            from django.db.models import DecimalField, OuterRef, Subquery, Sum, Value
            from django.db.models.functions import Coalesce
            paid_sq = (Payment.objects.filter(stay=OuterRef("pk")).values("stay")
                       .annotate(t=Sum("amount")).values("t"))
            qs = qs.annotate(paid_sum=Coalesce(Subquery(paid_sq, output_field=DecimalField(max_digits=12, decimal_places=2)),
                                               Value(ZERO), output_field=DecimalField(max_digits=12, decimal_places=2)))
            qs = qs.filter(**{"owed": {"total_amount__gt": F("paid_sum")}, "paid": {"total_amount": F("paid_sum")},
                              "credit": {"total_amount__lt": F("paid_sum")}}[balance])
        if not p.get("page"):
            return Response(StaySerializer(list(qs[:500]), many=True).data)
        try:
            size = min(max(int(p.get("page_size") or 25), 5), 200)
            page = max(int(p.get("page") or 1), 1)
        except ValueError:
            raise ValidationError({"page": "Use a number."})
        count = qs.count()
        pages = max((count + size - 1) // size, 1)
        page = min(page, pages)
        rows = list(qs[(page - 1) * size: page * size])
        data = {"count": count, "page": page, "page_size": size, "pages": pages,
                "results": StaySerializer(rows, many=True).data}
        if p.get("has_balance") == "1":
            from django.db.models import Sum as _Sum
            agg = qs.aggregate(t=_Sum("total_amount"), pd=_Sum("paid_sum"))
            data["owed"] = str((agg["t"] or ZERO) - (agg["pd"] or ZERO))
        return Response(data)

    def destroy(self, request, *args, **kwargs):
        if request.user.role != User.CLIENT_ADMIN:
            raise PermissionDenied("Only the client admin can delete guests.")
        stay = self.get_object()
        with transaction.atomic():
            stay.is_deleted = True
            stay.deleted_at = timezone.now()
            stay.deleted_by = request.user
            stay.save()
            _move_carried_back(stay, +1)   # balance brought from the previous stay goes back to it
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
        if stay.status == Stay.CHECKED_IN:
            other = _room_taken_by(stay)
            if other and not _forced(request.data):
                raise ValidationError({"overlap": f"Room {stay.room.number} is now rented to {other.guest.name}. "
                                                  f"Recover {stay.guest.name} anyway?"})
        with transaction.atomic():
            stay.is_deleted = False
            stay.deleted_at = None
            stay.deleted_by = None
            stay.save()
            _move_carried_back(stay, -1)
        return Response(StaySerializer(stay).data)

    @action(detail=True, methods=["post"])
    def payments(self, request, pk=None):
        """Add a balance payment. It is linked to the stay, so it rolls into the check-in date report."""
        stay = self.get_object()
        if "cash" in request.data or "credit" in request.data or "check" in request.data:
            # Same as check-in: cash, card and / or check in one go, card fee added to the stay's charges.
            amounts = _pay_amounts(request.data)
            credit = dict(amounts)[Payment.CREDIT]
            fee = _decimal(request.data.get("card_fee") or 0, "card_fee")
            # Clerk edited the balance (like at check-in): difference is stored as an adjustment.
            adj = _decimal(request.data.get("adjustment_change") or 0, "balance", allow_negative=True)
            if sum(a for _, a in amounts) <= 0 and adj == 0:
                raise ValidationError({"amount": "Enter a cash, card or check amount."})
            if stay.total_amount + fee + adj < 0:
                raise ValidationError({"balance": "Total cannot go below zero."})
            if stay.total_amount + fee + adj > MAX_AMOUNT:
                raise ValidationError({"balance": "That amount is too large. Check the number."})
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
                for method, amt in amounts:
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
        _apply_damage(stay, request.data, request.user)
        stay.status = Stay.CHECKED_OUT
        stay.checked_out_at = timezone.now()
        stay.save()
        room_vacated(stay, request.user)
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
        if request.query_params.get("damage_fee") not in (None, ""):   # preview only, not saved
            stay.damage_fee = (stay.damage_fee or ZERO) + _decimal(request.query_params["damage_fee"], "damage_fee")
        return Response(early.quote(stay, depart, method, custom))

    @action(detail=True, methods=["post"])
    def early_checkout(self, request, pk=None):
        """
        Check a guest out before the booked date and (optionally) refund the difference.
        Body: date, method, room_charge (CUSTOM only), refund_amount (default = full refund due),
              refund_method CASH | CREDIT | CHECK, notes.
        """
        stay = self.get_object()
        depart, method, custom = self._early_args(stay, request.data)
        if _apply_damage(stay, request.data, request.user):
            stay.save()
        qt = early.quote(stay, depart, method, custom)
        due = Decimal(qt["refund_due"])
        raw = request.data.get("refund_amount")
        refund = due if raw in (None, "") else _decimal(raw, "refund_amount")
        if refund > due:
            raise ValidationError({"refund_amount": f"Refund cannot be more than {due}."})
        refund_method = request.data.get("refund_method") or Payment.CASH
        if refund > 0 and refund_method not in METHODS:
            raise ValidationError({"refund_method": "Use CASH, CREDIT or CHECK."})
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
            room_vacated(stay, request.user)
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
        Body: periods (nights / weeks / months by the stay's rent type), cash, credit, check, card_fee,
              pets, pet_fee_add, extra_person_fee_add (empty = automatic), late_fee_add, early_checkin_fee_add,
              adjustment_change (balance edited, like check-in), notes, allow_overlap (rent anyway if the room is booked after the current checkout).
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
        # Rent by: same choices as check-in. Default = the stay's own type and rate.
        rtype = request.data.get("rate_type") or stay.rate_type
        if rtype not in (Stay.DAILY, Stay.WEEKLY, Stay.MONTHLY):
            raise ValidationError({"rate_type": "Use DAILY, WEEKLY or MONTHLY."})
        raw_rate = request.data.get("rate")
        if raw_rate in (None, ""):
            if rtype == stay.rate_type:
                rate = Decimal(stay.rate)
            else:
                rt = stay.room.room_type
                daily = Decimal(rt.default_rate or 0)
                rate = Decimal({Stay.WEEKLY: rt.weekly_rate, Stay.MONTHLY: rt.monthly_rate}.get(rtype) or 0) or (
                    daily * (7 if rtype == Stay.WEEKLY else 30 if rtype == Stay.MONTHLY else 1))
        else:
            rate = _decimal(raw_rate, "rate")
        rate = rate.quantize(Decimal("0.01"))
        old_out = stay.check_out_date
        if rtype == Stay.WEEKLY:
            new_out = old_out + datetime.timedelta(days=7 * n)
        elif rtype == Stay.MONTHLY:
            m = old_out.month - 1 + n
            y, m = old_out.year + m // 12, m % 12 + 1
            import calendar
            new_out = old_out.replace(year=y, month=m, day=min(old_out.day, calendar.monthrange(y, m)[1]))
        else:
            new_out = old_out + datetime.timedelta(days=n)
        added_nights = (new_out - old_out).days
        same_terms = rtype == stay.rate_type and rate == Decimal(stay.rate)

        other = (Stay.objects.filter(room=stay.room, is_deleted=False, status=Stay.CHECKED_IN,
                                     check_in_date__lt=new_out, check_out_date__gt=old_out)
                 .exclude(pk=stay.pk).select_related("guest").first())
        if other and request.data.get("allow_overlap") not in (True, "true", "1", 1):
            raise ValidationError({"overlap": f"Room {stay.room.number} is booked for {other.guest.name} "
                                              f"from {other.check_in_date:%m/%d/%Y}. Add stay anyway?"})

        amounts = _pay_amounts(request.data)
        credit = dict(amounts)[Payment.CREDIT]
        fee = _decimal(request.data.get("card_fee") or 0, "card_fee")
        if fee > 0 and credit <= 0:
            raise ValidationError({"card_fee": "Card fee needs a card amount."})
        adj = _decimal(request.data.get("adjustment_change") or 0, "balance", allow_negative=True)
        # extra charges for the added stay (same boxes as check-in); empty extra person fee = automatic
        pet_add = _decimal(request.data.get("pet_fee_add") or 0, "pet_fee_add")
        late_add = _decimal(request.data.get("late_fee_add") or 0, "late_fee_add")
        early_add = _decimal(request.data.get("early_checkin_fee_add") or 0, "early_checkin_fee_add")
        raw_xp = request.data.get("extra_person_fee_add")
        xp_add = None if raw_xp in (None, "") else _decimal(raw_xp, "extra_person_fee_add")
        try:
            pets_now = int(request.data.get("pets")) if request.data.get("pets") not in (None, "") else None
        except (TypeError, ValueError):
            raise ValidationError({"pets": "Enter a number."})
        notes = (request.data.get("notes") or "").strip()[:255]
        unit = {Stay.DAILY: "night", Stay.WEEKLY: "week", Stay.MONTHLY: "month"}[rtype]

        with transaction.atomic():
            # extra person fee is per night: by default add the same nightly amount for the new nights
            if xp_add is not None:
                stay.extra_person_fee = (Decimal(stay.extra_person_fee or 0) + xp_add).quantize(Decimal("0.01"))
            elif stay.extra_person_fee and stay.num_days:
                per_night = Decimal(stay.extra_person_fee) / stay.num_days
                stay.extra_person_fee = (Decimal(stay.extra_person_fee) + per_night * added_nights).quantize(Decimal("0.01"))
            stay.pet_fee = (stay.pet_fee or ZERO) + pet_add
            stay.late_fee = (stay.late_fee or ZERO) + late_add
            stay.early_checkin_fee = (stay.early_checkin_fee or ZERO) + early_add
            if pets_now is not None and pets_now >= 0:
                stay.pets = pets_now
            if not same_terms:
                # different rent type / rate: charged separately, the stay's own nights stay as they were
                stay.extra_stay_nights = (stay.extra_stay_nights or 0) + added_nights
                stay.extra_stay_charge = (Decimal(stay.extra_stay_charge or 0) + rate * n).quantize(Decimal("0.01"))
            elif stay.rate_type != Stay.DAILY:
                stay.periods = stay.periods + n
            stay.check_out_date = new_out
            stay.card_fee = (stay.card_fee or ZERO) + fee
            stay.adjustment = (stay.adjustment or ZERO) + adj
            line = f"Stay added: {n} {unit}{'s' if n > 1 else ''}, checkout {old_out:%m/%d/%Y} -> {new_out:%m/%d/%Y}."
            if not same_terms:
                line += f" Rate {rate} per {unit} = {(rate * n).quantize(Decimal('0.01'))}."
            extras = [(lbl, v) for lbl, v in (("pet fee", pet_add), ("late fee", late_add), ("early check-in fee", early_add)) if v]
            if xp_add:
                extras.append(("extra person fee", xp_add))
            if extras:
                line += " Added " + ", ".join(f"{lbl} {v}" for lbl, v in extras) + "."
            if adj != 0:
                line += f" {'Discount' if adj < 0 else 'Extra charge'} of {abs(adj)} added."
            stay.comments = (stay.comments + "\n" if stay.comments else "") + line
            stay.save()
            if stay_qs(request.user.client).get(pk=stay.pk).total_amount < 0:
                raise ValidationError({"balance": "Total cannot go below zero."})
            now = timezone.now()
            for method, amt in amounts:
                if amt > 0:
                    Payment.objects.create(stay=stay, amount=amt, method=method, paid_at=now, clerk=request.user,
                                           kind=Payment.STAYOVER,
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
        if method not in METHODS:
            raise ValidationError({"method": "Use CASH, CREDIT or CHECK."})
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
            # normal checkout undone: the room may have been rented again since
            other = _room_taken_by(stay)
            if other and not _forced(request.data):
                raise ValidationError({"overlap": f"Room {stay.room.number} has been rented to {other.guest.name} "
                                                  f"since the checkout. Undo anyway?"})
            stay.status = Stay.CHECKED_IN
            stay.checked_out_at = None
            stay.save()
        stay = stay_qs(request.user.client).get(pk=stay.pk)
        return Response(StaySerializer(stay).data)


def _room_taken_by(stay):
    """Another in-house stay in the same room on any of this stay's nights (None if the room is free)."""
    end = stay.check_out_date if stay.check_out_date > stay.check_in_date else stay.check_in_date + datetime.timedelta(days=1)
    return (Stay.objects.filter(room=stay.room, is_deleted=False, status=Stay.CHECKED_IN,
                                check_in_date__lt=end, check_out_date__gt=stay.check_in_date)
            .exclude(pk=stay.pk).select_related("guest").first())


def _forced(data):
    return data.get("force") in (True, "true", "1", 1)


def _apply_damage(stay, data, user):
    """Checkout "Room condition": damage fee (added to the bill), notes, and optionally add the guest to DNR."""
    changed = False
    fee = _decimal(data.get("damage_fee") or 0, "damage_fee")
    notes = (data.get("damage_notes") or "").strip()[:500]
    if fee > 0:
        stay.damage_fee = (stay.damage_fee or ZERO) + fee
        changed = True
    if fee > 0 or notes:
        line = f"Room damage at checkout{f' (fee {fee})' if fee > 0 else ''}: {notes or 'see photos'}"
        stay.comments = (stay.comments + "\n" if stay.comments else "") + line
        changed = True
    if str(data.get("add_dnr")).lower() in ("true", "1"):
        g = stay.guest
        g.do_not_rent = True
        g.dnr_reason = (g.dnr_reason + "; " if g.dnr_reason else "") + (f"Room damage: {notes}" if notes else "Room damage")
        if not g.dnr_marked_by_id:
            g.dnr_marked_by = user
        g.save()
    return changed


METHOD_LABELS = {
    early.DAILY_RATE: "charged at daily rate",
    early.PRORATA: "charged pro-rata",
    early.NO_REFUND: "full charge kept",
    early.CUSTOM: "custom room charge",
}


MAX_AMOUNT = Decimal("99999999.99")   # money fields hold 10 digits, 2 after the point


def _decimal(value, field, allow_negative=False):
    """Parse an amount from a request. Rejects text, negatives (unless allowed) and amounts too big to store."""
    try:
        v = Decimal(str(value).strip() or "0").quantize(Decimal("0.01"))
    except Exception:
        raise ValidationError({field: "Enter a valid amount."})
    if v < 0 and not allow_negative:
        raise ValidationError({field: "Cannot be negative."})
    if abs(v) > MAX_AMOUNT:
        raise ValidationError({field: "That amount is too large. Check the number."})
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
    # all money taken on this business day (same rule as Today's Report), so the Room sheet footer
    # can show payments on stays that have no row (earlier stays, guests already gone, refunds)
    day_pays = Payment.objects.filter(stay__client=client, stay__is_deleted=False, business_date=day)
    day_cash = day_pays.filter(method=Payment.CASH).aggregate(t=Sum("amount"))["t"] or ZERO
    day_credit = day_pays.filter(method=Payment.CREDIT).aggregate(t=Sum("amount"))["t"] or ZERO
    day_check = day_pays.filter(method=Payment.CHECK).aggregate(t=Sum("amount"))["t"] or ZERO
    day_exps = Expense.objects.filter(client=client, business_date=day, is_deleted=False)
    exp_cash = day_exps.filter(method=Expense.CASH).aggregate(t=Sum("amount"))["t"] or ZERO
    exp_card = day_exps.filter(method=Expense.CREDIT).aggregate(t=Sum("amount"))["t"] or ZERO
    exp_check = day_exps.filter(method=Expense.CHECK).aggregate(t=Sum("amount"))["t"] or ZERO
    q2 = lambda v: str(Decimal(v).quantize(Decimal("0.01")))

    issues = _open_issue_counts(client)
    return Response({
        "date": day,
        "day_money": {"cash": q2(day_cash), "credit": q2(day_credit), "check": q2(day_check),
                      "expenses_cash": q2(exp_cash), "expenses_card": q2(exp_card), "expenses_check": q2(exp_check)},
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
            "open_problems": RoomIssue.objects.filter(client=client).exclude(status=RoomIssue.FIXED).count(),
            "out_of_order": Room.objects.filter(client=client, is_active=True, hk_status=Room.OUT_OF_ORDER).count(),
            "dirty": Room.objects.filter(client=client, is_active=True, hk_status__in=[Room.DIRTY, Room.CLEANING])
                                 .exclude(id__in=occupied_ids).count(),
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
             "due_out": r.id in due_out_ids,
             "hk_status": r.hk_status, "hk_note": r.hk_note, "open_issues": issues.get(r.id, 0)}
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
    rows, totals = [], {"total": ZERO, "cash": ZERO, "credit": ZERO, "check": ZERO, "paid_later": ZERO, "paid": ZERO, "balance": ZERO}
    for s in stays:
        # cash / credit / check = taken on the check-in day; money taken on later days counts on those days
        cash, credit = paid_on(s, s.check_in_date, Payment.CASH), paid_on(s, s.check_in_date, Payment.CREDIT)
        chk = paid_on(s, s.check_in_date, Payment.CHECK)
        all_paid = paid(s)
        later = all_paid - cash - credit - chk
        bal = s.total_amount - all_paid
        rows.append({
            "id": s.id, "check_in_date": s.check_in_date, "room_number": s.room.number,
            "room_type": s.room.room_type.name, "guest_name": s.guest.name,
            "num_guests": s.num_guests, "num_days": s.num_days, "rate": str(s.rate),
            "rate_type": s.rate_type, "periods": s.periods, "fees": str(s.charges_total),
            "total": str(s.total_amount), "cash": str(cash), "credit": str(credit), "check": str(chk),
            "paid_later": str(later), "paid": str(all_paid), "balance": str(bal),
            "clerk": (s.clerk.get_full_name() or s.clerk.username) if s.clerk else "",
            "status": s.status,
        })
        totals["total"] += s.total_amount
        totals["cash"] += cash
        totals["credit"] += credit
        totals["check"] += chk
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
    """Money actually collected per day (by payment date), cash / credit / check, net of refunds given."""
    client = get_request_client(request)
    start, end = _date_range(request, client=client)
    pays = (
        Payment.objects.filter(stay__client=client, stay__is_deleted=False, business_date__range=(start, end))
        .select_related("stay", "stay__guest", "stay__room", "clerk").order_by("paid_at")
    )
    by_day, detail = {}, []
    totals = {"cash": ZERO, "credit": ZERO, "check": ZERO, "refunds": ZERO, "total": ZERO}
    for p in pays:
        d = p.business_date
        row = by_day.setdefault(d, {"date": d, "cash": ZERO, "credit": ZERO, "check": ZERO, "refunds": ZERO, "total": ZERO, "count": 0})
        if p.kind == Payment.REFUND:
            row["refunds"] += -p.amount
            totals["refunds"] += -p.amount
        key = METHOD_KEY.get(p.method, "credit")
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
    days = [{**r, "cash": str(r["cash"]), "credit": str(r["credit"]), "check": str(r["check"]), "refunds": str(r["refunds"]), "total": str(r["total"])}
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
    check = sum((p.amount for p in pays if p.method == Payment.CHECK), ZERO)
    from_checkins = sum((p.amount for p in pays if p.stay.check_in_date == day), ZERO)
    refunds = sum((-p.amount for p in pays if p.kind == Payment.REFUND), ZERO)

    # expenses paid out on this business day (cash ones come out of the drawer)
    exps = list(Expense.objects.filter(client=client, business_date=day, is_deleted=False)
                .select_related("clerk", "client").order_by("created_at"))
    if mine:
        exps = [e for e in exps if e.clerk_id == request.user.id]
    exp_cash = sum((e.amount for e in exps if e.method == Expense.CASH), ZERO)
    exp_card = sum((e.amount for e in exps if e.method == Expense.CREDIT), ZERO)
    exp_check = sum((e.amount for e in exps if e.method == Expense.CHECK), ZERO)

    by_clerk = {}
    for p in pays:
        row = by_clerk.setdefault(clerk_name(p.clerk) or "Unknown", {"cash": ZERO, "credit": ZERO, "check": ZERO, "count": 0})
        row[METHOD_KEY.get(p.method, "credit")] += p.amount
        row["count"] += 1

    # occupancy tonight
    total_rooms = Room.objects.filter(client=client, is_active=True).count()
    staying = list(base.filter(check_in_date__lte=day, check_out_date__gte=day))
    occupied = len({s.room_id for s in occupying_on(staying, day)})

    checkin_rows, booked, owed = [], ZERO, ZERO
    for s in checkins:
        c, cr, ck = paid_on(s, day, Payment.CASH), paid_on(s, day, Payment.CREDIT), paid_on(s, day, Payment.CHECK)
        other = paid(s) - c - cr - ck   # taken on other days (counted on those days)
        bal = s.total_amount - paid(s)
        booked += s.total_amount
        owed += max(bal, ZERO)
        checkin_rows.append({
            "id": s.id, "time": s.check_in_time, "room_number": s.room.number, "room_type": s.room.room_type.name,
            "guest_name": s.guest.name, "num_guests": s.num_guests, "num_days": s.num_days,
            "check_out_date": s.check_out_date, "rate": str(s.rate), "total": str(s.total_amount),
            "rate_type": s.rate_type, "periods": s.periods,
            "cash": str(c), "credit": str(cr), "check": str(ck), "paid_other_days": str(other),
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
            "check": str(check),
            "collected": str(cash + credit + check),
            "refunds": str(refunds),
            "received": str(cash + credit + check + refunds),
            "expenses_cash": str(exp_cash),
            "expenses_card": str(exp_card),
            "expenses_check": str(exp_check),
            "expenses": str(exp_cash + exp_card + exp_check),
            "cash_in_drawer": str(cash - exp_cash),
            "net": str(cash + credit + check - exp_cash - exp_card - exp_check),
            "from_todays_checkins": str(from_checkins),
            "from_earlier_stays": str(cash + credit + check - from_checkins),
            "unpaid_from_todays_checkins": str(owed),
        },
        "by_clerk": [
            {"clerk": k, "cash": str(v["cash"]), "credit": str(v["credit"]), "check": str(v["check"]),
             "total": str(v["cash"] + v["credit"] + v["check"]), "count": v["count"]}
            for k, v in sorted(by_clerk.items())
        ],
        "checkins": checkin_rows,
        "checkouts": [{
            "id": s.id, "room_number": s.room.number, "guest_name": s.guest.name,
            "check_in_date": s.check_in_date, "total": str(s.total_amount),
            "balance": str(s.total_amount - paid(s)), "status": s.status,
        } for s in checkouts],
        "expenses": ExpenseSerializer(exps, many=True, context={"request": request}).data,
        "payments": [{
            "id": p.id, "paid_at": p.paid_at, "business_date": p.business_date, "method": p.method, "amount": str(p.amount),
            "type": pay_type(p),
            "guest_name": p.stay.guest.name, "room_number": p.stay.room.number,
            "stay_id": p.stay_id, "check_in_date": p.stay.check_in_date, "clerk": clerk_name(p.clerk),
        } for p in pays],
    })


# ------------------------------------------------------------------ maintenance
class ExpenseViewSet(viewsets.ModelViewSet):
    """
    Expenses paid by the front desk (shown in Today's Report > Cash drawer).
    ?date=YYYY-MM-DD filters by business day. Delete keeps the record (is_deleted).
    """

    permission_classes = [IsClientStaff]
    serializer_class = ExpenseSerializer

    def get_queryset(self):
        qs = Expense.objects.filter(client=self.request.user.client, is_deleted=False).select_related("clerk", "client")
        if self.request.query_params.get("date"):
            qs = qs.filter(business_date=parse_date(self.request.query_params["date"]))
        return qs

    def perform_create(self, serializer):
        client = self.request.user.client
        day = serializer.validated_data.get("business_date") or business.business_date(client)
        serializer.save(client=client, clerk=self.request.user, business_date=day)

    def _check(self, exp):
        if not expense_editable(exp, self.request.user):
            raise PermissionDenied("You can only change your own expenses on the current business day. Ask the admin.")

    def perform_update(self, serializer):
        self._check(serializer.instance)
        serializer.save()

    def perform_destroy(self, instance):
        self._check(instance)
        instance.is_deleted = True
        instance.deleted_at = timezone.now()
        instance.deleted_by = self.request.user
        instance.save()


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

    # guest checked out and checked in again (or extended, or a new guest moved in): the room is
    # occupied tonight, so it is not a room to clean
    in_tonight = set(Stay.objects.filter(client=client, is_deleted=False, status=Stay.CHECKED_IN,
                                         check_in_date__lte=day, check_out_date__gt=day).values_list("room_id", flat=True))
    rooms, seen = [], set(in_tonight)
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
    check = sum((p.amount for p in pays if p.method == Payment.CHECK), ZERO)
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
        # guests who should have left today but are still checked in (warned before Night Audit)
        "still_due_out_guests": [{"stay_id": s.id, "room": s.room.number, "guest": s.guest.name,
                                  "check_out_time": s.check_out_time.strftime("%H:%M"),
                                  "balance": str(s.total_amount - paid(s))}
                                 for s in sorted(due_out, key=lambda x: (len(x.room.number), x.room.number))],
        "unpaid_checkins": len(unpaid),
        "unpaid_amount": str(sum((s.total_amount - paid(s) for s in unpaid), ZERO)),
        "occupied": occupied,
        "total_rooms": total_rooms,
        "payments": len(pays),
        "cash": str(cash),
        "credit": str(credit),
        "check": str(check),
        "refunds": str(refunds),
        "collected": str(cash + credit + check),
    }


def _close_row(c):
    return {
        "date": c.date, "closed_at": c.closed_at,
        "closed_by": (c.closed_by.get_full_name() or c.closed_by.username) if c.closed_by else "",
        "summary": c.summary,
    }


def _disk_free_gb():
    import shutil
    from django.conf import settings as dj
    try:
        os_path = dj.MEDIA_ROOT
        import os
        os.makedirs(os_path, exist_ok=True)
        return round(shutil.disk_usage(os_path).free / 1024 ** 3, 1)
    except OSError:
        return None


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
        "disk_free_gb": _disk_free_gb(),
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
    # Closed by mistake: money taken after the close was counted on the next day.
    # Move it back to the reopened day (only what was entered after the close, on that next day).
    nxt = last.date + datetime.timedelta(days=1)
    with transaction.atomic():
        pays = Payment.objects.filter(stay__client=client, business_date=nxt, paid_at__gte=last.closed_at)
        exps = Expense.objects.filter(client=client, business_date=nxt, created_at__gte=last.closed_at)
        n_pay, n_exp = pays.update(business_date=last.date), exps.update(business_date=last.date)
        later_checkins = Stay.objects.filter(client=client, is_deleted=False, check_in_date=nxt,
                                             created_at__gte=last.closed_at).count()
        last.delete()
    state = _business_state(client)
    notes = []
    if n_pay or n_exp:
        notes.append(f"Moved back to {last.date:%m/%d/%Y}: {n_pay} payment(s), {n_exp} expense(s) entered after the close.")
    if later_checkins:
        notes.append(f"{later_checkins} check-in(s) made after the close keep their date {nxt:%m/%d/%Y}; edit them if needed.")
    state["note"] = " ".join(notes)
    state["moved_payments"], state["moved_expenses"] = n_pay, n_exp
    return Response(state)


@api_view(["GET"])
@permission_classes([IsClientStaff])
def business_day_history(request):
    closes = DayClose.objects.filter(client=request.user.client).select_related("closed_by")[:60]
    return Response([_close_row(c) for c in closes])


# ------------------------------------------------------------------ payment history report
@api_view(["GET"])
@permission_classes([IsClientStaffOrSuperAdmin])
def report_payment_history(request):
    """
    Payment history for guests: filter by room number, date range (stays on those dates) and / or guest name.
    Returns each stay with the guest's details and every payment and refund, oldest first.
    """
    client = get_request_client(request)
    p = request.query_params
    room, name = (p.get("room") or "").strip(), (p.get("name") or "").strip()
    start = parse_date(p.get("start"), None, "start") if p.get("start") else None
    end = parse_date(p.get("end"), None, "end") if p.get("end") else None
    if not (room or name or start or end):
        raise ValidationError({"detail": "Pick a room, a date or a guest name."})
    if start and end and end < start:
        raise ValidationError({"end": "End date is before start date."})
    qs = stay_qs(client).filter(is_deleted=False)
    if room:
        qs = qs.filter(room__number__iexact=room)
    if name:
        qs = qs.filter(guest__name__icontains=name)
    if start:
        qs = qs.filter(check_out_date__gte=start)
    if end:
        qs = qs.filter(check_in_date__lte=end)
    stays = list(qs.order_by("-check_in_date", "-id")[:201])
    more = len(stays) > 200
    stays = stays[:200]

    def clerk(u):
        return (u.get_full_name() or u.username) if u else ""

    rows, totals = [], {"total": ZERO, "cash": ZERO, "credit": ZERO, "check": ZERO, "refunds": ZERO, "paid": ZERO, "balance": ZERO}
    for s in stays:
        pays = sorted(s.payments.all(), key=lambda x: x.paid_at)
        cash = sum((x.amount for x in pays if x.method == Payment.CASH), ZERO)
        credit = sum((x.amount for x in pays if x.method == Payment.CREDIT), ZERO)
        check = sum((x.amount for x in pays if x.method == Payment.CHECK), ZERO)
        refunds = sum((-x.amount for x in pays if x.kind == Payment.REFUND), ZERO)
        bal = s.total_amount - cash - credit - check
        g = s.guest
        rows.append({
            "id": s.id, "status": s.status,
            "guest": {"name": g.name, "phone": g.phone, "address": ", ".join(x for x in (g.address, g.city, g.state, g.zip_code) if x),
                      "car": g.car, "license_plate": g.license_plate, "dl_number": g.dl_number, "do_not_rent": g.do_not_rent},
            "room_number": s.room.number, "room_type": s.room.room_type.name,
            "check_in_date": s.check_in_date, "check_out_date": s.check_out_date, "num_days": s.num_days,
            "rate": str(s.rate), "rate_type": s.rate_type, "num_guests": s.num_guests,
            "room_charge": str(s.room_charge), "fees": str(s.charges_total), "adjustment": str(s.adjustment),
            "total": str(s.total_amount), "cash": str(cash), "credit": str(credit), "check": str(check), "refunds": str(refunds),
            "paid": str(cash + credit + check), "balance": str(bal),
            "payments": [{
                "id": x.id, "business_date": x.business_date, "paid_at": x.paid_at, "type": pay_type(x),
                "method": x.method, "amount": str(x.amount), "clerk": clerk(x.clerk), "notes": x.notes,
            } for x in pays],
        })
        totals["total"] += s.total_amount
        totals["cash"] += cash
        totals["credit"] += credit
        totals["check"] += check
        totals["refunds"] += refunds
        totals["paid"] += cash + credit + check
        totals["balance"] += bal
    return Response({"count": len(rows), "more": more, "rows": rows, "totals": {k: str(v) for k, v in totals.items()}})



# ------------------------------------------------------------------ photos (DL and room damage)
MAX_PHOTO = 10 * 1024 * 1024


def _save_upload(f, *, client, kind, user, stay=None, guest=None, via="", session=None, issue=None):
    import uuid
    if f is None:
        raise ValidationError({"image": "Choose a photo."})
    if not (getattr(f, "content_type", "") or "").startswith("image/"):
        raise ValidationError({"image": "Only photos (JPG / PNG) can be uploaded."})
    if f.size > MAX_PHOTO:
        raise ValidationError({"image": "Photo is larger than 10 MB."})
    if kind not in dict(Photo.KINDS):
        raise ValidationError({"kind": "Unknown photo type."})
    ph = Photo(client=client, kind=kind, stay=stay, guest=guest, via=via[:10], uploaded_by=user, session=session, issue=issue)
    ph.file.save(f"pending/{uuid.uuid4().hex}.jpg", f, save=False)
    ph.save()
    if stay or guest or issue:
        place_photo(ph)
    # clean up form photos that were never saved with a check-in (older than 2 days)
    old = timezone.now() - datetime.timedelta(days=2)
    for p in Photo.objects.filter(client=client, stay__isnull=True, guest__isnull=True, issue__isnull=True, created_at__lt=old):
        delete_photo_file(p)
        p.delete()
    return ph


class PhotoViewSet(mixins.ListModelMixin, mixins.CreateModelMixin, mixins.DestroyModelMixin,
                   viewsets.GenericViewSet):
    """
    DL / damage photos. Files are private: /photos/{id}/file/ needs a logged-in staff user.
    POST (multipart): image, kind, stay or guest (optional; none = waiting for the check-in to be saved), via.
    """

    permission_classes = [IsMaintenanceOrStaff]
    serializer_class = PhotoSerializer

    def get_queryset(self):
        qs = Photo.objects.filter(client=self.request.user.client).select_related("uploaded_by")
        if self.request.user.role == User.MAINTENANCE:
            qs = qs.filter(kind=Photo.ISSUE)   # housekeeping only sees room-problem photos, never DL photos
        p = self.request.query_params
        if p.get("issue"):
            qs = qs.filter(issue_id=p["issue"])
        if p.get("stay"):
            qs = qs.filter(stay_id=p["stay"])
        if p.get("guest"):
            qs = qs.filter(guest_id=p["guest"])
        if p.get("ids"):
            qs = qs.filter(id__in=[int(x) for x in p["ids"].split(",") if x.strip().isdigit()])
        if p.get("kind") == "DL":
            qs = qs.filter(kind__in=[Photo.DL_FRONT, Photo.DL_BACK])
        elif p.get("kind"):
            qs = qs.filter(kind=p["kind"])
        return qs

    def create(self, request, *args, **kwargs):
        client = request.user.client
        stay = guest = issue = None
        kind = request.data.get("kind")
        if request.user.role == User.MAINTENANCE and kind != Photo.ISSUE:
            raise PermissionDenied("Housekeeping can only add room-problem photos.")
        if kind == Photo.ISSUE:
            issue = RoomIssue.objects.filter(client=client, pk=request.data.get("issue")).first()
            if not issue:
                raise ValidationError({"issue": "Problem not found."})
            if issue.photos.count() >= 10:
                raise ValidationError({"image": "Up to 10 photos per problem."})
        elif request.data.get("stay"):
            stay = Stay.objects.filter(client=client, pk=request.data["stay"]).first()
            if not stay:
                raise ValidationError({"stay": "Stay not found."})
            guest = stay.guest if request.data.get("kind") in (Photo.DL_FRONT, Photo.DL_BACK) else None
        elif request.data.get("guest"):
            guest = Guest.objects.filter(client=client, pk=request.data["guest"]).first()
        ph = _save_upload(request.FILES.get("image"), client=client, kind=kind,
                          user=request.user, stay=stay, guest=guest, via=request.data.get("via") or "FILE", issue=issue)
        return Response(PhotoSerializer(ph).data, status=status.HTTP_201_CREATED)

    def perform_destroy(self, instance):
        delete_photo_file(instance)
        instance.delete()

    @action(detail=True, methods=["get"])
    def file(self, request, pk=None):
        from django.http import FileResponse, Http404
        ph = self.get_object()
        try:
            return FileResponse(ph.file.open("rb"), content_type="image/jpeg")
        except (FileNotFoundError, ValueError):
            raise Http404("Photo file is missing.")

    @action(detail=False, methods=["get"])
    def guest_last_dl(self, request):
        """Returning guest: their last DL photos (front / back), to reuse on a new check-in."""
        out = []
        for kind in (Photo.DL_FRONT, Photo.DL_BACK):
            ph = (Photo.objects.filter(client=request.user.client, guest_id=request.query_params.get("guest"), kind=kind)
                  .order_by("-created_at").first())
            if ph:
                out.append(PhotoSerializer(ph).data)
        return Response(out)


def _lan_ip():
    import socket
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))   # no data is sent; just picks the WiFi / network address
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return "127.0.0.1"


@api_view(["POST"])
@permission_classes([IsClientStaff])
def photo_session_create(request):
    """"Use phone": start a 10-minute upload link and return its QR code (SVG)."""
    import secrets
    from urllib.parse import urlparse
    import segno
    from django.conf import settings as dj
    if not dj.HOST_ON_WIFI:
        raise ValidationError({"detail": "Use phone needs MotelMitra on the WiFi: set HOST_ON_WIFI=yes in backend\\.env and run start_app.bat again."})
    client = request.user.client
    kind = request.data.get("kind")
    if kind not in dict(Photo.KINDS):
        raise ValidationError({"kind": "Unknown photo type."})
    stay = None
    if request.data.get("stay"):
        stay = Stay.objects.filter(client=client, pk=request.data["stay"]).first()
    sess = PhotoSession.objects.create(
        token=secrets.token_urlsafe(12), client=client, created_by=request.user, kind=kind, stay=stay,
        expires_at=timezone.now() + datetime.timedelta(minutes=10),
    )
    origin = urlparse(request.data.get("origin") or "http://localhost:5173")
    host = origin.hostname or "localhost"
    if host in ("localhost", "127.0.0.1", "::1"):
        host = _lan_ip()       # a phone cannot open "localhost": use this PC's WiFi address
    port = f":{origin.port}" if origin.port else ""
    url = f"{origin.scheme or 'http'}://{host}{port}/m/{sess.token}"
    svg = segno.make(url, error="m").svg_inline(scale=5, border=2)
    return Response({"token": sess.token, "url": url, "qr_svg": svg, "expires_at": sess.expires_at}, status=201)


@api_view(["GET"])
@permission_classes([IsClientStaff])
def photo_session_status(request, token):
    """The PC polls this to show photos as soon as the phone sends them."""
    sess = PhotoSession.objects.filter(client=request.user.client, token=token).first()
    if not sess:
        raise ValidationError({"token": "Unknown link."})
    return Response({"expired": sess.expires_at < timezone.now(), "expires_at": sess.expires_at,
                     "photos": PhotoSerializer(sess.photos.all(), many=True).data})


def _phone_session(token):
    sess = PhotoSession.objects.filter(token=token).select_related("client", "stay", "stay__room").first()
    if not sess or sess.expires_at < timezone.now():
        raise ValidationError({"detail": "This photo link has expired. Ask the front desk for a new QR code."})
    return sess


@api_view(["GET"])
@permission_classes([])
def phone_info(request, token):
    """Phone page (no login): what this link is for."""
    sess = _phone_session(token)
    return Response({
        "motel": sess.client.name, "kind": sess.kind, "kind_label": dict(Photo.KINDS)[sess.kind],
        "room": sess.stay.room.number if sess.stay else None, "expires_at": sess.expires_at,
        "count": sess.photos.count(),
    })


@api_view(["POST"])
@permission_classes([])
def phone_upload(request, token):
    """Phone page (no login): upload one photo to the session (DL: front or back; damage: many)."""
    sess = _phone_session(token)
    kind = request.data.get("kind") or sess.kind
    if sess.kind == Photo.DAMAGE:
        kind = Photo.DAMAGE
    elif kind not in (Photo.DL_FRONT, Photo.DL_BACK):
        kind = Photo.DL_FRONT
    if sess.photos.count() >= 20:
        raise ValidationError({"detail": "Too many photos for one link."})
    stay = sess.stay
    ph = _save_upload(request.FILES.get("image"), client=sess.client, kind=kind, user=sess.created_by,
                      stay=stay, guest=stay.guest if stay and kind != Photo.DAMAGE else None, via="PHONE", session=sess)
    return Response({"ok": True, "id": ph.id, "kind": ph.kind}, status=201)


# ------------------------------------------------------------------ WiFi printer / scanner
# "Scan now" talks to the printer with eSCL (AirScan), which most WiFi printers made since ~2015 support.
# "Scan folder" lists the newest images the printer's own "Scan to PC" saved into a folder on this PC.
ESCL_NS = "http://schemas.hp.com/imaging/escl/2011/05/03"


def _scanner_base(client):
    addr = (client.scanner_address or "").strip().rstrip("/")
    if not addr:
        raise ValidationError({"detail": "No scanner set. The admin can add the printer's IP in Charges & Fees."})
    if not addr.startswith(("http://", "https://")):
        addr = "http://" + addr
    return addr


def _scanner_request(url, data=None, method="GET", timeout=20):
    import ssl
    import urllib.error
    import urllib.request
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Content-Type": "text/xml"} if data else {})
    ctx = ssl._create_unverified_context()   # printers use self-signed certificates
    try:
        return urllib.request.urlopen(req, timeout=timeout, context=ctx)
    except urllib.error.HTTPError as e:
        if e.code == 503:
            raise ValidationError({"detail": "The printer is busy. Wait a moment and try again."})
        raise ValidationError({"detail": f"The printer answered with error {e.code}. It may not support direct scan; use Scan folder."})
    except (urllib.error.URLError, OSError, TimeoutError):
        raise ValidationError({"detail": "Cannot reach the printer. Check it is on, on the same WiFi, and the IP address is right."})


@api_view(["GET"])
@permission_classes([IsClientStaff])
def scanner_test(request):
    """Check the scanner: printer model from eSCL, and how many scans are in the scan folder."""
    import os
    import re
    client = request.user.client
    out = {"direct": None, "folder": None}
    if client.scanner_address:
        try:
            body = _scanner_request(_scanner_base(client) + "/eSCL/ScannerCapabilities", timeout=6).read().decode("utf-8", "ignore")
            model = re.search(r"<pwg:MakeAndModel>(.*?)</pwg:MakeAndModel>", body)
            out["direct"] = {"ok": True, "model": model.group(1) if model else "Scanner found"}
        except ValidationError as e:
            out["direct"] = {"ok": False, "error": e.detail.get("detail") if isinstance(e.detail, dict) else str(e.detail)}
    if client.scan_folder:
        ok = os.path.isdir(client.scan_folder)
        out["folder"] = {"ok": ok, "error": "" if ok else "Folder not found on this PC."}
    return Response(out)


@api_view(["POST"])
@permission_classes([IsClientStaff])
def scanner_scan(request):
    """Scan now: start a scan job on the printer and return the image (JPEG)."""
    import time
    from urllib.parse import urljoin
    from django.http import HttpResponse
    client = request.user.client
    base = _scanner_base(client)
    area = (request.data.get("area") or client.scanner_area or "DL").upper()
    # size in 1/300 inch: DL card area (4.5 x 3 in, top-left corner of the glass) or a full Letter page
    w, h = (1350, 900) if area == "DL" else (2550, 3300)
    settings_xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<scan:ScanSettings xmlns:scan="{ESCL_NS}" xmlns:pwg="http://www.pwg.org/schemas/2010/12/sm">
  <pwg:Version>2.0</pwg:Version>
  <pwg:ScanRegions><pwg:ScanRegion>
    <pwg:ContentRegionUnits>escl:ThreeHundredthsOfInches</pwg:ContentRegionUnits>
    <pwg:XOffset>0</pwg:XOffset><pwg:YOffset>0</pwg:YOffset>
    <pwg:Width>{w}</pwg:Width><pwg:Height>{h}</pwg:Height>
  </pwg:ScanRegion></pwg:ScanRegions>
  <pwg:InputSource>Platen</pwg:InputSource>
  <scan:ColorMode>RGB24</scan:ColorMode>
  <scan:XResolution>300</scan:XResolution><scan:YResolution>300</scan:YResolution>
  <pwg:DocumentFormat>image/jpeg</pwg:DocumentFormat>
  <scan:DocumentFormatExt>image/jpeg</scan:DocumentFormatExt>
</scan:ScanSettings>""".encode()
    # Start the job. "Busy" usually means an old job is stuck (a scan that timed out or was closed)
    # or the printer is waking up: clear stuck jobs, wait, try again before giving up.
    resp = None
    for attempt in range(SCAN_RETRIES):
        try:
            resp = _scanner_request(base + "/eSCL/ScanJobs", data=settings_xml, method="POST", timeout=20)
            break
        except ValidationError as e:
            if "busy" not in str(e.detail):
                raise
            if attempt == 0:
                _cancel_stuck_jobs(base)
            time.sleep(SCAN_RETRY_WAIT)
    if resp is None:
        raise ValidationError({"detail": _busy_message(_scanner_status(base)[0])})
    job = resp.headers.get("Location")
    if not job:
        raise ValidationError({"detail": "The printer did not start a scan job."})
    job = urljoin(base + "/", job)
    try:
        for _ in range(30):   # the scan head needs a few seconds
            try:
                img = _scanner_request(job.rstrip("/") + "/NextDocument", timeout=60).read()
                if img:
                    return HttpResponse(img, content_type="image/jpeg")
            except ValidationError as e:
                if "busy" not in str(e.detail):
                    raise
            time.sleep(1)
        raise ValidationError({"detail": "The scan took too long. Try again."})
    finally:
        _delete_job(job)   # always free the printer, so the next scan does not find it busy


SCAN_RETRIES = 4          # tries to start a scan when the printer says busy
SCAN_RETRY_WAIT = 3       # seconds between tries


def _scanner_status(base):
    """(state, [active job URIs]) from eSCL ScannerStatus. state: Idle / Processing / Stopped / None."""
    import re
    try:
        body = _scanner_request(base + "/eSCL/ScannerStatus", timeout=6).read().decode("utf-8", "ignore")
    except ValidationError:
        return None, []
    m = re.search(r"<(?:\w+:)?State>\s*(\w+)\s*<", body)
    jobs = []
    for info in re.findall(r"<(?:\w+:)?JobInfo>(.*?)</(?:\w+:)?JobInfo>", body, re.S):
        uri = re.search(r"<(?:\w+:)?JobUri>\s*(.*?)\s*<", info)
        st = re.search(r"<(?:\w+:)?JobState>\s*(\w+)\s*<", info)
        if uri and st and st.group(1) in ("Pending", "Processing"):
            jobs.append(uri.group(1))
    return (m.group(1) if m else None), jobs


def _delete_job(url):
    try:
        _scanner_request(url, method="DELETE", timeout=6)
    except ValidationError:
        pass


def _cancel_stuck_jobs(base):
    from urllib.parse import urljoin
    for uri in _scanner_status(base)[1]:
        _delete_job(urljoin(base + "/", uri))


def _busy_message(state):
    if state == "Stopped":
        return ("The printer's scanner is stopped. Check the printer screen for a message (lid open, paper jam, "
                "error) and press OK or Cancel there, then try again.")
    if state == "Processing":
        return ("The printer is busy with another job (printing, copying or a scan started on the printer). "
                "Wait for it to finish, then try again.")
    return ("The printer is still busy. On the printer, press Cancel or Home to leave any menu, wait 10 seconds "
            "and try again. If it keeps happening, switch the printer off and on.")


_SCAN_EXT = (".jpg", ".jpeg", ".png", ".bmp", ".webp")


@api_view(["GET"])
@permission_classes([IsClientStaff])
def scanner_folder(request):
    """Scan folder: newest images (last 2 days) saved there by the printer's Scan to PC."""
    import os
    client = request.user.client
    folder = client.scan_folder
    if not folder:
        raise ValidationError({"detail": "No scan folder set. The admin can add it in Charges & Fees."})
    if not os.path.isdir(folder):
        raise ValidationError({"detail": f"Scan folder not found on this PC: {folder}"})
    cutoff = timezone.now().timestamp() - 2 * 86400
    files = []
    for entry in os.scandir(folder):
        if entry.is_file() and entry.name.lower().endswith(_SCAN_EXT):
            st = entry.stat()
            if st.st_mtime >= cutoff:
                files.append({"name": entry.name, "modified": datetime.datetime.fromtimestamp(st.st_mtime, datetime.timezone.utc),
                              "size_kb": round(st.st_size / 1024)})
    files.sort(key=lambda f: f["modified"], reverse=True)
    return Response({"folder": folder, "files": files[:24]})


@api_view(["GET"])
@permission_classes([IsClientStaff])
def scanner_folder_file(request):
    import mimetypes
    import os
    from django.http import FileResponse, Http404
    folder = request.user.client.scan_folder
    name = os.path.basename(request.query_params.get("name") or "")   # never leave the scan folder
    path = os.path.join(folder or "", name)
    if not folder or not name or not name.lower().endswith(_SCAN_EXT) or not os.path.isfile(path):
        raise Http404("Scan not found.")
    return FileResponse(open(path, "rb"), content_type=mimetypes.guess_type(name)[0] or "image/jpeg")


# ------------------------------------------------------------------ housekeeping
HK_LABEL = dict(Room.HK_CHOICES)


def _open_issue_counts(client):
    from django.db.models import Count
    return dict(RoomIssue.objects.filter(client=client).exclude(status=RoomIssue.FIXED)
                .values_list("room_id").annotate(n=Count("id")).values_list("room_id", "n"))


def set_room_status(room, status, user, note="", stay=None, action=RoomStatusLog.STATUS):
    """Change a room's housekeeping status and keep a record of who did it."""
    if status not in HK_LABEL:
        raise ValidationError({"status": "Unknown room status."})
    old = room.hk_status
    room.hk_status = status
    room.hk_note = (note or "")[:255] if status == Room.OUT_OF_ORDER else ""
    room.hk_updated_at = timezone.now()
    room.hk_updated_by = user if getattr(user, "pk", None) else None
    room.save(update_fields=["hk_status", "hk_note", "hk_updated_at", "hk_updated_by"])
    RoomStatusLog.objects.create(client=room.client, room=room, action=action, from_status=old, to_status=status,
                                 note=(note or "")[:255], stay=stay, user=room.hk_updated_by,
                                 business_date=business.business_date(room.client))
    return room


def room_vacated(stay, user):
    """Guest checked out: the room needs cleaning (unless someone else is already in it tonight,
    or it is out of order)."""
    room = stay.room
    day = business.business_date(stay.client)
    others = Stay.objects.filter(room=room, is_deleted=False, status=Stay.CHECKED_IN,
                                 check_in_date__lte=day, check_out_date__gt=day).exclude(pk=stay.pk)
    if room.hk_status != Room.OUT_OF_ORDER and not others.exists():
        set_room_status(room, Room.DIRTY, user, note="Guest checked out", stay=stay)


def _user_name(u):
    return (u.get_full_name() or u.username) if u else ""


@api_view(["GET"])
@permission_classes([IsMaintenanceOrStaff])
def housekeeping_board(request):
    """
    Housekeeping screen (maintenance, clerks, admin): every room with its status, who is in it tonight,
    stay-over service for today, and open problems. No guest names or money for maintenance.
    """
    client = request.user.client
    day = business.business_date(client)
    staff = request.user.role != User.MAINTENANCE
    stays = list(Stay.objects.filter(client=client, is_deleted=False, check_in_date__lte=day, check_out_date__gte=day)
                 .select_related("guest"))
    tonight = {s.room_id: s for s in occupying_on(stays, day)}
    due_out = {s.room_id: s for s in stays if s.status == Stay.CHECKED_IN and s.check_out_date == day}
    services = {}
    for lg in (RoomStatusLog.objects.filter(client=client, action=RoomStatusLog.SERVICE, business_date=day)
               .select_related("user").order_by("created_at")):
        services[lg.room_id] = lg   # last one wins
    issues = _open_issue_counts(client)
    rooms = []
    for r in Room.objects.filter(client=client, is_active=True).select_related("room_type", "hk_updated_by"):
        s = tonight.get(r.id)
        out = due_out.get(r.id)
        if out and (not s or s.pk == out.pk):
            occupancy = "due_out"          # guest leaves today, not checked out yet
        elif s:
            occupancy = "in_house"
        else:
            occupancy = "vacant"
        stay_over = bool(s and s.check_in_date < day and s.check_out_date > day)
        svc = services.get(r.id)
        rooms.append({
            "id": r.id, "number": r.number, "room_type": r.room_type.name,
            "hk_status": r.hk_status, "hk_label": HK_LABEL[r.hk_status], "hk_note": r.hk_note,
            "hk_updated_at": r.hk_updated_at, "hk_updated_by": _user_name(r.hk_updated_by),
            "occupancy": occupancy,
            "guest_name": (s or out).guest.name if staff and (s or out) else None,
            "check_out_date": (s or out).check_out_date if (s or out) else None,
            "service": (svc.to_status if svc else "NEEDED") if stay_over else None,
            "service_by": _user_name(svc.user) if svc else "", "service_at": svc.created_at if svc else None,
            "service_log_id": svc.id if svc else None,
            "open_issues": issues.get(r.id, 0),
        })
    rooms.sort(key=lambda x: (len(x["number"]), x["number"]))
    count = lambda pred: sum(1 for x in rooms if pred(x))   # noqa: E731
    log = []
    if staff:
        log = [{
            "id": g.id, "room_number": g.room.number, "action": g.action, "from": HK_LABEL.get(g.from_status, g.from_status),
            "to": HK_LABEL.get(g.to_status, g.to_status.title()), "note": g.note, "by": _user_name(g.user), "at": g.created_at,
        } for g in RoomStatusLog.objects.filter(client=client).select_related("room", "user")[:40]]
    return Response({
        "date": day, "rooms": rooms, "log": log,
        "summary": {
            "dirty": count(lambda x: x["occupancy"] == "vacant" and x["hk_status"] == Room.DIRTY),
            "cleaning": count(lambda x: x["occupancy"] == "vacant" and x["hk_status"] == Room.CLEANING),
            "ready": count(lambda x: x["occupancy"] == "vacant" and x["hk_status"] == Room.READY),
            "out_of_order": count(lambda x: x["hk_status"] == Room.OUT_OF_ORDER),
            "due_out": count(lambda x: x["occupancy"] == "due_out"),
            "in_house": count(lambda x: x["occupancy"] == "in_house"),
            "service_needed": count(lambda x: x["service"] == "NEEDED"),
            "service_done": count(lambda x: x["service"] in ("DONE", "DECLINED")),
            "open_issues": sum(issues.values()),
        },
    })


@api_view(["POST"])
@permission_classes([IsMaintenanceOrStaff])
def housekeeping_set_status(request, room_id):
    """Change a room's status: READY / DIRTY / CLEANING / OUT_OF_ORDER (note = reason)."""
    room = Room.objects.filter(client=request.user.client, pk=room_id).first()
    if not room:
        raise ValidationError({"room": "Room not found."})
    st = request.data.get("status")
    note = (request.data.get("note") or "").strip()
    if st == Room.OUT_OF_ORDER and not note:
        raise ValidationError({"note": "Say why the room is out of order."})
    set_room_status(room, st, request.user, note=note)
    return Response({"id": room.id, "hk_status": room.hk_status, "hk_note": room.hk_note})


@api_view(["POST", "DELETE"])
@permission_classes([IsMaintenanceOrStaff])
def housekeeping_service(request, room_id):
    """Stay-over room serviced today: status DONE or DECLINED (guest said no). DELETE = undo today's entry."""
    client = request.user.client
    room = Room.objects.filter(client=client, pk=room_id).first()
    if not room:
        raise ValidationError({"room": "Room not found."})
    day = business.business_date(client)
    if request.method == "DELETE":
        RoomStatusLog.objects.filter(client=client, room=room, action=RoomStatusLog.SERVICE, business_date=day).delete()
        return Response(status=status.HTTP_204_NO_CONTENT)
    st = request.data.get("status") or "DONE"
    if st not in ("DONE", "DECLINED"):
        raise ValidationError({"status": "Use DONE or DECLINED."})
    lg = RoomStatusLog.objects.create(client=client, room=room, action=RoomStatusLog.SERVICE, to_status=st,
                                      note=(request.data.get("note") or "")[:255], user=request.user, business_date=day)
    return Response({"id": lg.id, "status": st}, status=status.HTTP_201_CREATED)


class RoomIssueViewSet(viewsets.ModelViewSet):
    """Room problems. Everyone (maintenance, clerk, admin) can report, update and mark fixed. Only the admin deletes."""
    permission_classes = [IsMaintenanceOrStaff]
    http_method_names = ["get", "post", "patch", "delete"]

    def get_serializer_class(self):
        return RoomIssueSerializer

    def get_queryset(self):
        qs = (RoomIssue.objects.filter(client=self.request.user.client)
              .select_related("room", "room__room_type", "reported_by", "fixed_by").prefetch_related("photos"))
        if self.action == "list":
            p = self.request.query_params
            st = p.get("status") or "active"
            if st == "active":
                qs = qs.exclude(status=RoomIssue.FIXED)
            elif st != "all":
                qs = qs.filter(status=st)
            if p.get("room"):
                qs = qs.filter(room_id=p["room"])
            if p.get("category"):
                qs = qs.filter(category=p["category"])
            qs = qs[:300]
        return qs

    def _note(self, issue, status_, note):
        issue.history = (issue.history or []) + [{
            "at": timezone.now().isoformat(), "by": _user_name(self.request.user), "status": status_, "note": note}]

    @transaction.atomic
    def perform_create(self, serializer):
        room = serializer.validated_data["room"]
        ooo = str(self.request.data.get("out_of_order")).lower() in ("true", "1", "yes")
        issue = serializer.save(client=self.request.user.client, reported_by=self.request.user, made_out_of_order=ooo)
        self._note(issue, RoomIssue.OPEN, "Reported" + (" · room put out of order" if ooo else ""))
        issue.save(update_fields=["history"])
        if ooo and room.hk_status != Room.OUT_OF_ORDER:
            set_room_status(room, Room.OUT_OF_ORDER, self.request.user,
                            note=f"{issue.get_category_display()}: {issue.description[:180]}")

    def perform_update(self, serializer):
        inst = serializer.instance
        old = inst.status
        issue = serializer.save()
        note = (self.request.data.get("note") or "").strip()[:255]
        if issue.status != old or note:
            if issue.status == RoomIssue.FIXED and old != RoomIssue.FIXED:
                issue.fixed_by, issue.fixed_at = self.request.user, timezone.now()
            elif issue.status != RoomIssue.FIXED:
                issue.fixed_by, issue.fixed_at = None, None
            self._note(issue, issue.status, note or {"OPEN": "Reopened", "IN_PROGRESS": "Work started", "FIXED": "Fixed"}[issue.status])
            issue.save(update_fields=["history", "fixed_by", "fixed_at"])

    def destroy(self, request, *args, **kwargs):
        if request.user.role != User.CLIENT_ADMIN:
            raise PermissionDenied("Only the admin can delete a problem. Mark it Fixed instead.")
        return super().destroy(request, *args, **kwargs)


# ------------------------------------------------------------------ custom reports
# Reports -> Custom reports: the motel picks a source, columns, filters, grouping and sorting.
# Rows are built in Python from whitelisted fields only (no free SQL), capped at CR_MAX_ROWS.
CR_MAX_ROWS = 5000
_CR_TEXT, _CR_CHOICE, _CR_DATE, _CR_MONEY, _CR_INT = "text", "choice", "date", "money", "int"


def _cr_fields():
    """Field catalogue per source: key -> (label, type). Choice fields can be grouped and filtered by value."""
    return {
        "stays": {
            "label": "Check-ins (stays)",
            "date_fields": {"check_in": "Check-in date", "check_out": "Check-out date"},
            "fields": {
                "check_in": ("Check-in", _CR_DATE), "check_out": ("Check-out", _CR_DATE),
                "room": ("Room", _CR_CHOICE), "room_type": ("Room type", _CR_CHOICE),
                "guest": ("Guest", _CR_TEXT), "phone": ("Phone", _CR_TEXT), "plate": ("Plate", _CR_TEXT),
                "dl": ("DL number", _CR_TEXT), "city": ("City", _CR_CHOICE), "state": ("State", _CR_CHOICE),
                "rate_type": ("Rent type", _CR_CHOICE), "status": ("Status", _CR_CHOICE),
                "clerk": ("Clerk", _CR_CHOICE), "dnr": ("DNR", _CR_CHOICE),
                "nights": ("Nights", _CR_INT), "guests": ("Guests", _CR_INT),
                "rate": ("Rate", _CR_MONEY), "room_charge": ("Room charge", _CR_MONEY), "fees": ("Fees", _CR_MONEY),
                "total": ("Total", _CR_MONEY), "cash": ("Cash paid", _CR_MONEY), "credit": ("Card paid", _CR_MONEY),
                "check": ("Check paid", _CR_MONEY), "refunds": ("Refunds", _CR_MONEY), "paid": ("Paid", _CR_MONEY), "balance": ("Balance", _CR_MONEY),
            },
        },
        "payments": {
            "label": "Payments (money taken)",
            "date_fields": {"date": "Business day"},
            "fields": {
                "date": ("Business day", _CR_DATE), "time": ("Time", _CR_TEXT),
                "type": ("Type", _CR_CHOICE), "method": ("Method", _CR_CHOICE), "amount": ("Amount", _CR_MONEY),
                "cash": ("Cash", _CR_MONEY), "credit": ("Credit", _CR_MONEY), "check": ("Check", _CR_MONEY),
                "guest": ("Guest", _CR_TEXT), "room": ("Room", _CR_CHOICE), "room_type": ("Room type", _CR_CHOICE),
                "check_in": ("Check-in", _CR_DATE), "clerk": ("Clerk", _CR_CHOICE), "notes": ("Notes", _CR_TEXT),
            },
        },
        "expenses": {
            "label": "Expenses",
            "date_fields": {"date": "Business day"},
            "fields": {
                "date": ("Business day", _CR_DATE), "description": ("Description", _CR_TEXT),
                "method": ("Paid by", _CR_CHOICE), "amount": ("Amount", _CR_MONEY),
                "cash": ("Cash", _CR_MONEY), "credit": ("Card", _CR_MONEY), "check": ("Check", _CR_MONEY),
                "clerk": ("Clerk", _CR_CHOICE),
            },
        },
        "problems": {
            "label": "Room problems",
            "date_fields": {"reported": "Reported date", "fixed": "Fixed date"},
            "fields": {
                "reported": ("Reported", _CR_DATE), "room": ("Room", _CR_CHOICE), "room_type": ("Room type", _CR_CHOICE),
                "category": ("Type", _CR_CHOICE), "priority": ("Priority", _CR_CHOICE), "status": ("Status", _CR_CHOICE),
                "description": ("Problem", _CR_TEXT), "reported_by": ("Reported by", _CR_CHOICE),
                "fixed": ("Fixed", _CR_DATE), "fixed_by": ("Fixed by", _CR_CHOICE),
                "days_open": ("Days open", _CR_INT), "out_of_order": ("Out of order", _CR_CHOICE),
            },
        },
        "guests": {
            "label": "Guests (from check-ins in the period)",
            "date_fields": {"check_in": "Check-in date"},
            "fields": {
                "guest": ("Guest", _CR_TEXT), "phone": ("Phone", _CR_TEXT), "plate": ("Plate", _CR_TEXT),
                "city": ("City", _CR_CHOICE), "state": ("State", _CR_CHOICE), "dnr": ("DNR", _CR_CHOICE),
                "stays": ("Stays", _CR_INT), "nights": ("Nights", _CR_INT),
                "first_stay": ("First check-in", _CR_DATE), "last_stay": ("Last check-in", _CR_DATE),
                "total": ("Total", _CR_MONEY), "cash": ("Cash paid", _CR_MONEY), "credit": ("Card paid", _CR_MONEY),
                "check": ("Check paid", _CR_MONEY), "balance": ("Balance", _CR_MONEY),
            },
        },
    }


def _cr_name(u):
    return (u.get_full_name() or u.username) if u else ""


def _cr_stay_rows(client, start, end, date_field):
    flt = {"check_in_date__range": (start, end)} if date_field != "check_out" else {"check_out_date__range": (start, end)}
    rows = []
    for s in stay_qs(client).filter(is_deleted=False, **flt).order_by("check_in_date", "room__number"):
        pays = list(s.payments.all())
        cash = sum((p.amount for p in pays if p.method == Payment.CASH and p.kind != Payment.REFUND), ZERO)
        credit = sum((p.amount for p in pays if p.method == Payment.CREDIT and p.kind != Payment.REFUND), ZERO)
        chk = sum((p.amount for p in pays if p.method == Payment.CHECK and p.kind != Payment.REFUND), ZERO)
        refunds = sum((p.amount for p in pays if p.kind == Payment.REFUND), ZERO)
        paid_all = cash + credit + chk + refunds
        g = s.guest
        rows.append({
            "_id": s.id, "_guest_id": g.id,
            "check_in": s.check_in_date, "check_out": s.check_out_date, "room": s.room.number,
            "room_type": s.room.room_type.name, "guest": g.name, "phone": g.phone, "plate": g.license_plate,
            "dl": g.dl_number, "city": g.city, "state": g.state, "rate_type": s.get_rate_type_display(),
            "status": "In house" if s.status == Stay.CHECKED_IN else "Checked out", "clerk": _cr_name(s.clerk),
            "dnr": "Yes" if g.do_not_rent else "No", "nights": s.num_days, "guests": s.num_guests,
            "rate": s.rate, "room_charge": s.room_charge, "fees": s.charges_total, "total": s.total_amount,
            "cash": cash, "credit": credit, "check": chk, "refunds": refunds, "paid": paid_all, "balance": s.total_amount - paid_all,
        })
    return rows


def _cr_rows(client, source, start, end, date_field):
    if source == "stays":
        return _cr_stay_rows(client, start, end, date_field)
    if source == "payments":
        pays = (Payment.objects.filter(stay__client=client, stay__is_deleted=False, business_date__range=(start, end))
                .select_related("stay", "stay__guest", "stay__room", "stay__room__room_type", "clerk").order_by("paid_at"))
        return [{
            "_id": p.stay_id, "date": p.business_date, "time": timezone.localtime(p.paid_at).strftime("%I:%M %p").lstrip("0"),
            "type": pay_type(p), "method": METHOD_LABEL.get(p.method, p.method), "amount": p.amount,
            "cash": p.amount if p.method == Payment.CASH else ZERO, "credit": p.amount if p.method == Payment.CREDIT else ZERO,
            "check": p.amount if p.method == Payment.CHECK else ZERO,
            "guest": p.stay.guest.name, "room": p.stay.room.number, "room_type": p.stay.room.room_type.name,
            "check_in": p.stay.check_in_date, "clerk": _cr_name(p.clerk), "notes": p.notes,
        } for p in pays]
    if source == "expenses":
        exps = (Expense.objects.filter(client=client, is_deleted=False, business_date__range=(start, end))
                .select_related("clerk").order_by("business_date", "created_at"))
        return [{
            "date": e.business_date, "description": e.description, "method": {"CASH": "Cash", "CREDIT": "Card", "CHECK": "Check"}.get(e.method, e.method),
            "amount": e.amount, "cash": e.amount if e.method == Expense.CASH else ZERO,
            "credit": e.amount if e.method == Expense.CREDIT else ZERO,
            "check": e.amount if e.method == Expense.CHECK else ZERO, "clerk": _cr_name(e.clerk),
        } for e in exps]
    if source == "problems":
        # Dates are business days (a problem reported at 2 AM belongs to the day before, like payments).
        bday = lambda ts: business.auto_date(client, ts) if ts else None   # noqa: E731
        field = "fixed_at__date__range" if date_field == "fixed" else "created_at__date__range"
        today = business.business_date(client)
        rows = []
        for i in (RoomIssue.objects.filter(client=client, **{field: (start, end + datetime.timedelta(days=1))})
                  .select_related("room", "room__room_type", "reported_by", "fixed_by").order_by("created_at")):
            reported, fixed = bday(i.created_at), bday(i.fixed_at)
            check = fixed if date_field == "fixed" else reported
            if not (start <= check <= end):
                continue
            rows.append({
                "reported": reported, "room": i.room.number, "room_type": i.room.room_type.name,
                "category": i.get_category_display(), "priority": i.get_priority_display(), "status": i.get_status_display(),
                "description": i.description, "reported_by": _cr_name(i.reported_by), "fixed": fixed,
                "fixed_by": _cr_name(i.fixed_by), "days_open": max(0, ((fixed or today) - reported).days),
                "out_of_order": "Yes" if i.made_out_of_order else "No",
            })
        return rows
    if source == "guests":
        out = {}
        for r in _cr_stay_rows(client, start, end, "check_in"):
            g = out.setdefault(r["_guest_id"], {
                "guest": r["guest"], "phone": r["phone"], "plate": r["plate"], "city": r["city"], "state": r["state"],
                "dnr": r["dnr"], "stays": 0, "nights": 0, "first_stay": r["check_in"], "last_stay": r["check_in"],
                "total": ZERO, "cash": ZERO, "credit": ZERO, "check": ZERO, "balance": ZERO,
            })
            g["stays"] += 1
            g["nights"] += r["nights"]
            g["first_stay"] = min(g["first_stay"], r["check_in"])
            g["last_stay"] = max(g["last_stay"], r["check_in"])
            for k in ("total", "cash", "credit", "check", "balance"):
                g[k] += r[k]
        return list(out.values())
    raise ValidationError({"source": "Unknown source."})


def _cr_match(value, ftype, op, want):
    """One filter: field op value. Text ops: contains / is / not; numbers: > < = >= <=; dates: on / after / before."""
    if want in (None, "") and op not in ("empty", "not_empty"):
        return True
    if op == "empty":
        return value in (None, "")
    if op == "not_empty":
        return value not in (None, "")
    if ftype in (_CR_MONEY, _CR_INT):
        try:
            v, w = Decimal(str(value or 0)), Decimal(str(want))
        except Exception:
            raise ValidationError({"filters": f"'{want}' is not a number."})
        return {"gt": v > w, "lt": v < w, "eq": v == w, "gte": v >= w, "lte": v <= w, "ne": v != w}.get(op, v == w)
    if ftype == _CR_DATE:
        w = parse_date(want, field="filters")
        return {"on": value == w, "after": value > w, "before": value < w, "gte": value >= w, "lte": value <= w}.get(op, value == w)
    v, w = str(value or "").lower(), str(want).strip().lower()
    if op == "is":
        return v == w
    if op == "not":
        return v != w
    if op == "starts":
        return v.startswith(w)
    return w in v


def _cr_group_key(value, ftype, bucket):
    if ftype != _CR_DATE or not value:
        return value or "(blank)"
    if bucket == "week":
        monday = value - datetime.timedelta(days=value.weekday())
        return f"Week of {monday:%m/%d/%Y}"
    if bucket == "month":
        return value.strftime("%Y-%m")
    if bucket == "weekday":
        return value.strftime("%A")
    if bucket == "year":
        return value.strftime("%Y")
    return value


def _cr_out(v):
    if isinstance(v, Decimal):
        return str(v.quantize(Decimal("0.01")))
    if isinstance(v, (datetime.date,)):
        return v.isoformat()
    return v


def run_custom_report(client, cfg):
    cat = _cr_fields()
    source = cfg.get("source") or "stays"
    if source not in cat:
        raise ValidationError({"source": "Pick a source."})
    spec = cat[source]
    fields = spec["fields"]
    date_field = cfg.get("date_field") or next(iter(spec["date_fields"]))
    if date_field not in spec["date_fields"]:
        raise ValidationError({"date_field": "Pick a date field."})
    start = parse_date(cfg.get("start"), field="start")
    end = parse_date(cfg.get("end"), field="end")
    if end < start:
        raise ValidationError({"end": "End date is before the start date."})
    if (end - start).days > 731:
        raise ValidationError({"end": "Range cannot exceed 2 years."})
    if not isinstance(cfg.get("filters") or [], list) or any(not isinstance(f, dict) for f in (cfg.get("filters") or [])):
        raise ValidationError({"filters": "Filters must be a list."})
    cols_in = cfg.get("columns") or []
    if not isinstance(cols_in, list):
        raise ValidationError({"columns": "Columns must be a list."})
    columns = [c for c in cols_in if isinstance(c, str) and c in fields] or list(fields)[:6]

    rows = _cr_rows(client, source, start, end, date_field)
    for f in cfg.get("filters") or []:
        key = f.get("field")
        if key not in fields:
            continue
        rows = [r for r in rows if _cr_match(r.get(key), fields[key][1], f.get("op") or "", f.get("value"))]

    # numbers that make sense to add up (a rate does not)
    numeric = [c for c in columns if fields[c][1] in (_CR_MONEY, _CR_INT) and c != "rate"]
    group_by = cfg.get("group_by") or ""
    if group_by and group_by in fields:
        bucket = cfg.get("group_bucket") or "day"
        gtype = fields[group_by][1]
        groups = {}
        for r in rows:
            k = _cr_group_key(r.get(group_by), gtype, bucket)
            g = groups.setdefault(k, {"_count": 0, **{c: (0 if fields[c][1] == _CR_INT else ZERO) for c in numeric}})
            g["_count"] += 1
            for c in numeric:
                g[c] += r.get(c) or 0
        glabel = fields[group_by][0] + ("" if gtype != _CR_DATE or bucket == "day" else f" ({bucket})")
        out_cols = [{"key": group_by, "label": glabel, "type": _CR_TEXT if bucket != "day" else gtype},
                    {"key": "_count", "label": "Count", "type": _CR_INT}] + \
                   [{"key": c, "label": fields[c][0], "type": fields[c][1]} for c in numeric]
        out_rows = [{group_by: k, **v} for k, v in groups.items()]
        keys = [c["key"] for c in out_cols]
    else:
        out_cols = [{"key": c, "label": fields[c][0], "type": fields[c][1]} for c in columns]
        out_rows = rows
        keys = columns

    sort = cfg.get("sort") or ""
    if sort in keys:
        desc = cfg.get("sort_dir") == "desc"
        def sk(r):
            v = r.get(sort)
            return (v is None or v == "", v if not isinstance(v, str) else v.lower())
        try:
            out_rows = sorted(out_rows, key=sk, reverse=desc)
        except TypeError:
            out_rows = sorted(out_rows, key=lambda r: str(r.get(sort) or ""), reverse=desc)

    total_keys = [c["key"] for c in out_cols if c["type"] in (_CR_MONEY, _CR_INT) and c["key"] != "rate"]
    totals = {}
    for k in total_keys:
        totals[k] = _cr_out(sum((r.get(k) or 0) for r in out_rows))
    truncated = len(out_rows) > CR_MAX_ROWS
    return {
        "source": source, "start": start, "end": end, "columns": out_cols, "grouped": bool(group_by and group_by in fields),
        "count": len(out_rows), "row_count": len(rows), "truncated": truncated, "totals": totals,
        "rows": [[_cr_out(r.get(k)) for k in keys] for r in out_rows[:CR_MAX_ROWS]],
        "ids": [r.get("_id") for r in out_rows[:CR_MAX_ROWS]] if not (group_by and group_by in fields) else [],
    }


@api_view(["GET"])
@permission_classes([IsClientStaff])
def custom_report_fields(request):
    """Catalogue for the builder: sources, their date fields and fields (with types), and choice values."""
    client = request.user.client
    cat = _cr_fields()
    choices = {
        "room": sorted(Room.objects.filter(client=client).values_list("number", flat=True), key=lambda x: (len(x), x)),
        "room_type": list(RoomType.objects.filter(client=client).values_list("name", flat=True)),
        "clerk": sorted({_cr_name(u) for u in User.objects.filter(client=client)}),
        "rate_type": ["Daily", "Weekly", "Monthly"], "status": ["In house", "Checked out"], "dnr": ["Yes", "No"],
        "type": ["Check-in", "Balance payment", "Stay-over payment", "Refund"],
        "method": ["Cash", "Credit", "Card", "Check"],
        "category": [c[1] for c in RoomIssue.CATEGORIES], "priority": [c[1] for c in RoomIssue.PRIORITIES],
        "out_of_order": ["Yes", "No"],
    }
    return Response({
        "sources": [{"key": k, "label": v["label"], "date_fields": v["date_fields"],
                     "fields": [{"key": fk, "label": fv[0], "type": fv[1]} for fk, fv in v["fields"].items()]}
                    for k, v in cat.items()],
        "choices": choices,
        # same field name, different values on another source
        "choices_by_source": {"problems": {"status": [c[1] for c in RoomIssue.STATUSES]}},
    })


@api_view(["POST"])
@permission_classes([IsClientStaff])
def custom_report_run(request):
    """Run a report from a config (the builder) without saving it."""
    return Response(run_custom_report(request.user.client, request.data or {}))


class CustomReportViewSet(viewsets.ModelViewSet):
    """Saved custom reports, shared by the motel's staff. Anyone can save; the creator or the admin can change / delete."""
    permission_classes = [IsClientStaff]

    def get_queryset(self):
        return CustomReport.objects.filter(client=self.request.user.client).select_related("created_by")

    def get_serializer_class(self):
        return CustomReportSerializer

    def perform_create(self, serializer):
        name = serializer.validated_data["name"].strip()
        if CustomReport.objects.filter(client=self.request.user.client, name__iexact=name).exists():
            raise ValidationError({"name": "A report with this name already exists."})
        serializer.save(client=self.request.user.client, created_by=self.request.user, name=name)

    def _can_change(self, obj):
        u = self.request.user
        if u.role != User.CLIENT_ADMIN and obj.created_by_id != u.id:
            raise PermissionDenied("Only the person who saved this report or the admin can change it.")

    def perform_update(self, serializer):
        self._can_change(serializer.instance)
        name = serializer.validated_data.get("name", serializer.instance.name).strip()
        if CustomReport.objects.filter(client=self.request.user.client, name__iexact=name).exclude(pk=serializer.instance.pk).exists():
            raise ValidationError({"name": "A report with this name already exists."})
        serializer.save(name=name)

    def perform_destroy(self, instance):
        self._can_change(instance)
        instance.delete()
