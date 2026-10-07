"""Motel subscription status (plans are added by the super admin on the Clients screen).

* active     a plan covers today
* expiring   a plan covers today and ends within WARN_DAYS (staff see a warning popup)
* expired    no plan covers today, and an earlier plan has ended: client users cannot use MotelMitra;
             the client admin can log in and only sees the "plan expired" screen
* none       the motel never had a plan (older installs): works as before, super admin sees "No plan"
"""
import calendar
import datetime

from django.utils import timezone

WARN_DAYS = 7


def add_months(day, n):
    m = day.month - 1 + n
    y, m = day.year + m // 12, m % 12 + 1
    return day.replace(year=y, month=m, day=min(day.day, calendar.monthrange(y, m)[1]))


def end_for(start, months):
    """1 month from 10/06 = up to and including 11/05."""
    return add_months(start, months) - datetime.timedelta(days=1)


def plan_status(client, today=None):
    today = today or timezone.localdate()
    if client is None:
        return {"status": "none"}
    subs = list(client.subscriptions.all())
    if not subs:
        return {"status": "none", "today": today}
    current = next((s for s in sorted(subs, key=lambda s: s.start_date) if s.start_date <= today <= s.end_date), None)
    # paid up to: the end of the chain of plans that follow on from the current one (renewals bought early)
    if current:
        upto = current.end_date
        for s in sorted(subs, key=lambda s: s.start_date):
            if s.start_date <= upto + datetime.timedelta(days=1) and s.end_date > upto:
                upto = s.end_date
        days_left = (upto - today).days
        status = "expiring" if days_left < WARN_DAYS else "active"
        cur = current
    else:
        future = [s for s in subs if s.start_date > today]
        if future and not [s for s in subs if s.end_date < today]:
            # first plan starts later: let them work until it starts
            cur = min(future, key=lambda s: s.start_date)
            return {"status": "active", "today": today, "plan_name": cur.plan_name, "start_date": cur.start_date,
                    "end_date": cur.end_date, "paid_until": cur.end_date, "days_left": (cur.end_date - today).days,
                    "warn_days": WARN_DAYS, "price": str(cur.price)}
        cur = max(subs, key=lambda s: s.end_date)
        upto = cur.end_date
        days_left = (upto - today).days
        status = "expired"
    return {
        "status": status, "today": today, "plan_name": cur.plan_name, "months": cur.months, "price": str(cur.price),
        "start_date": cur.start_date, "end_date": cur.end_date, "paid_until": upto, "days_left": days_left,
        "warn_days": WARN_DAYS,
    }


def is_expired(client):
    return client is not None and plan_status(client)["status"] == "expired"
