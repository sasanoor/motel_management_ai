"""
Business day (the front desk's working day).

* It changes automatically at the motel's "day change time" (default 11:00 AM):
  before that time the desk is still on yesterday's date (night shift, early checkouts).
* Night Audit closes the day early: once a day is closed, the next day starts right away.
* Money is counted on the business day it was received (Payment.business_date).
"""
import datetime

from django.utils import timezone


def auto_date(client, now=None):
    now = timezone.localtime(now or timezone.now())
    change = client.day_change_time or datetime.time(0, 0)
    return now.date() if now.time() >= change else now.date() - datetime.timedelta(days=1)


def last_close(client):
    from .models import DayClose
    return DayClose.objects.filter(client=client).order_by("-date").select_related("closed_by").first()


def business_date(client, now=None):
    if client is None:
        return timezone.localdate()
    day = auto_date(client, now)
    last = last_close(client)
    if last and last.date >= day:
        day = last.date + datetime.timedelta(days=1)
    return day
