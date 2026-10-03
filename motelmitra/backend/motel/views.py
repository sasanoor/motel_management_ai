import datetime
from decimal import Decimal

from django.db.models import Q
from django.utils import timezone
from rest_framework import mixins, status, viewsets
from rest_framework.decorators import action, api_view, permission_classes
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.permissions import BasePermission, SAFE_METHODS
from rest_framework.response import Response

from accounts.models import User
from accounts.permissions import IsClientStaff, IsClientStaffOrSuperAdmin, get_request_client

from .models import Guest, Payment, Room, RoomType, Stay
from .serializers import (
    GuestSerializer, PaymentSerializer, RoomSerializer, RoomTypeSerializer,
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
        day = parse_date(request.query_params.get("date"))
        client = request.user.client
        stays = stay_qs(client).filter(is_deleted=False, check_in_date__lte=day, check_out_date__gte=day)
        by_room = {s.room_id: s for s in occupying_on(stays, day)}
        rooms = Room.objects.filter(client=client, is_active=True).select_related("room_type")
        data = []
        for r in rooms:
            s = by_room.get(r.id)
            data.append({
                "id": r.id, "number": r.number, "room_type": r.room_type.name,
                "default_rate": str(r.room_type.default_rate),
                "occupied": bool(s),
                "stay_id": s.id if s else None,
                "guest_name": s.guest.name if s else None,
                "check_out_date": s.check_out_date if s else None,
            })
        return Response(data)


# ------------------------------------------------------------------ guests
class GuestViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin,
                   mixins.UpdateModelMixin, viewsets.GenericViewSet):
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
        ser = PaymentSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        ser.save(stay=stay, clerk=request.user, paid_at=timezone.now())
        stay = stay_qs(request.user.client).get(pk=stay.pk)
        return Response(StaySerializer(stay).data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=["post"])
    def checkout(self, request, pk=None):
        stay = self.get_object()
        stay.status = Stay.CHECKED_OUT
        stay.checked_out_at = timezone.now()
        stay.save()
        return Response(StaySerializer(stay).data)

    @action(detail=True, methods=["post"])
    def reopen(self, request, pk=None):
        stay = self.get_object()
        stay.status = Stay.CHECKED_IN
        stay.checked_out_at = None
        stay.save()
        return Response(StaySerializer(stay).data)


# ------------------------------------------------------------------ dashboard
@api_view(["GET"])
@permission_classes([IsClientStaff])
def dashboard(request):
    """Home page: checkouts due on the date, everyone staying that date, quick stats."""
    client = request.user.client
    day = parse_date(request.query_params.get("date"))
    base = stay_qs(client).filter(is_deleted=False)
    staying = list(base.filter(check_in_date__lte=day, check_out_date__gte=day).order_by("room__number"))
    checkouts = [s for s in staying if s.check_out_date == day]
    arrivals = [s for s in staying if s.check_in_date == day]
    occupied = occupying_on(staying, day)
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
        },
        "checkouts": StaySerializer(checkouts, many=True).data,
        "staying": StaySerializer(staying, many=True).data,
    })


# ------------------------------------------------------------------ reports
def _date_range(request, max_days=93):
    today = timezone.localdate()
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
    start, end = _date_range(request)
    stays = stay_qs(client).filter(is_deleted=False, check_in_date__range=(start, end)).order_by("check_in_date", "room__number")
    rows, totals = [], {"total": ZERO, "cash": ZERO, "credit": ZERO, "paid": ZERO, "balance": ZERO}
    for s in stays:
        cash, credit = paid(s, Payment.CASH), paid(s, Payment.CREDIT)
        bal = s.total_amount - cash - credit
        rows.append({
            "id": s.id, "check_in_date": s.check_in_date, "room_number": s.room.number,
            "room_type": s.room.room_type.name, "guest_name": s.guest.name,
            "num_guests": s.num_guests, "num_days": s.num_days, "rate": str(s.rate),
            "total": str(s.total_amount), "cash": str(cash), "credit": str(credit),
            "paid": str(cash + credit), "balance": str(bal),
            "clerk": (s.clerk.get_full_name() or s.clerk.username) if s.clerk else "",
            "status": s.status,
        })
        totals["total"] += s.total_amount
        totals["cash"] += cash
        totals["credit"] += credit
        totals["paid"] += cash + credit
        totals["balance"] += bal
    return Response({
        "start": start, "end": end, "count": len(rows), "rows": rows,
        "totals": {k: str(v) for k, v in totals.items()},
    })


@api_view(["GET"])
@permission_classes([IsClientStaffOrSuperAdmin])
def report_collections(request):
    """Money actually collected per day (by payment date), cash vs credit."""
    client = get_request_client(request)
    start, end = _date_range(request)
    tz = timezone.get_current_timezone()
    lo = timezone.make_aware(datetime.datetime.combine(start, datetime.time.min), tz)
    hi = timezone.make_aware(datetime.datetime.combine(end + datetime.timedelta(days=1), datetime.time.min), tz)
    pays = (
        Payment.objects.filter(stay__client=client, stay__is_deleted=False, paid_at__gte=lo, paid_at__lt=hi)
        .select_related("stay", "stay__guest", "stay__room", "clerk").order_by("paid_at")
    )
    by_day, detail = {}, []
    totals = {"cash": ZERO, "credit": ZERO, "total": ZERO}
    for p in pays:
        d = timezone.localdate(p.paid_at)
        row = by_day.setdefault(d, {"date": d, "cash": ZERO, "credit": ZERO, "total": ZERO, "count": 0})
        key = "cash" if p.method == Payment.CASH else "credit"
        row[key] += p.amount
        row["total"] += p.amount
        row["count"] += 1
        totals[key] += p.amount
        totals["total"] += p.amount
        detail.append({
            "id": p.id, "paid_at": p.paid_at, "method": p.method, "amount": str(p.amount),
            "type": "Check-in" if p.is_initial else "Balance payment",
            "guest_name": p.stay.guest.name, "room_number": p.stay.room.number,
            "check_in_date": p.stay.check_in_date,
            "clerk": (p.clerk.get_full_name() or p.clerk.username) if p.clerk else "",
        })
    days = [{**r, "cash": str(r["cash"]), "credit": str(r["credit"]), "total": str(r["total"])}
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
    start, end = _date_range(request)
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
        revenue = sum((s.rate for s in occ), ZERO)
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
