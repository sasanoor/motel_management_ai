"""
Early checkout: work out what the guest owes for the nights actually used and how much to refund.

Rules
-----
* Nights used = days from check-in to the departure date, minimum 1 (leaving on the check-in day = 1 night).
* Room charge for the nights used, by method:
    DAILY_RATE  nights used x daily rate (weekend rate on Friday / Saturday nights) (the stay's own rate for daily stays, the room type's daily
                rate for weekly / monthly stays). Never more than the original room charge.
    PRORATA     original room charge x nights used / nights booked.
    NO_REFUND   original room charge (guest pays for the full booking).
    CUSTOM      amount entered by the clerk (0 .. original room charge).
* Extra person fee is per night, so it is reduced to the nights used (not for NO_REFUND).
* Pet fee, card fee, late fee and any discount / adjustment stay as they are.
* Refund due = what was paid (net of earlier refunds) minus the new total, never below 0.
  If the guest paid less than the new total, there is no refund and the rest is still owed.
"""
from decimal import ROUND_HALF_UP, Decimal

ZERO = Decimal("0.00")
CENT = Decimal("0.01")

DAILY_RATE = "DAILY_RATE"
PRORATA = "PRORATA"
NO_REFUND = "NO_REFUND"
CUSTOM = "CUSTOM"
METHODS = (DAILY_RATE, PRORATA, NO_REFUND, CUSTOM)


def q(x):
    return Decimal(x).quantize(CENT, rounding=ROUND_HALF_UP)


def original_values(stay):
    """Values as booked, even if an early checkout was already applied (taken from the snapshot)."""
    snap = stay.early_snapshot or {}
    return {
        "check_out_date": snap.get("check_out_date") or stay.check_out_date.isoformat(),
        "nights": int(snap.get("nights") or stay.num_days),
        "room_charge": Decimal(snap.get("room_charge") or stay.room_charge),
        "extra_person_fee": Decimal(snap.get("extra_person_fee") or stay.extra_person_fee or 0),
    }


def net_paid(stay):
    return sum((p.amount for p in stay.payments.all()), ZERO)


def _used_charge(stay, daily, used):
    """Nights used at the daily rate; Friday / Saturday nights at the weekend rate when the stay has one."""
    wk_rate = Decimal(getattr(stay, "weekend_rate", 0) or 0)
    if stay.rate_type == "DAILY" and wk_rate > 0:
        from .models import count_weekend_nights
        wk = count_weekend_nights(stay.check_in_date, used)
        return daily * (used - wk) + wk_rate * wk
    return daily * used


def quote(stay, depart, method=DAILY_RATE, custom_room_charge=None):
    import datetime
    orig = original_values(stay)
    orig_out = datetime.date.fromisoformat(orig["check_out_date"])
    booked = max(orig["nights"], 1)
    used = max((depart - stay.check_in_date).days, 1)
    used = min(used, booked)
    unused = booked - used
    orig_room = q(orig["room_charge"])

    if stay.rate_type == "DAILY":
        daily = Decimal(stay.rate)
    else:
        daily = Decimal(stay.room.room_type.default_rate)

    options = {
        DAILY_RATE: min(q(_used_charge(stay, daily, used)), orig_room),
        PRORATA: q(orig_room * used / booked),
        NO_REFUND: orig_room,
    }
    if method == CUSTOM:
        c = q(custom_room_charge if custom_room_charge is not None else orig_room)
        room = max(min(c, orig_room), ZERO)
    else:
        room = options[method]

    extra = q(orig["extra_person_fee"]) if method == NO_REFUND else q(orig["extra_person_fee"] * used / booked)
    fixed = sum((Decimal(x or 0) for x in (stay.pet_fee, stay.card_fee, stay.late_fee, stay.early_checkin_fee, stay.damage_fee)), ZERO)
    new_total = q(room + extra + fixed + Decimal(stay.adjustment or 0))
    paid = q(net_paid(stay))
    refund_due = max(paid - new_total, ZERO)
    balance_due = max(new_total - paid, ZERO)

    return {
        "depart_date": depart,
        "original_check_out_date": orig_out,
        "nights_booked": booked,
        "nights_used": used,
        "nights_unused": unused,
        "is_early": depart < orig_out,
        "daily_rate": str(q(daily)),
        "original_room_charge": str(orig_room),
        "options": {k: str(v) for k, v in options.items()},
        "method": method,
        "room_charge": str(room),
        "extra_person_fee": str(extra),
        "kept_charges": str(q(fixed)),
        "adjustment": str(q(stay.adjustment or 0)),
        "original_total": str(q(stay.total_amount if not stay.early_snapshot else stay.early_snapshot.get("total", stay.total_amount))),
        "new_total": str(new_total),
        "paid": str(paid),
        "refund_due": str(q(refund_due)),
        "balance_due": str(q(balance_due)),
    }
