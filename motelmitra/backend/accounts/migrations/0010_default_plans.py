from decimal import Decimal

from django.db import migrations

DEFAULTS = [("Monthly", 1, Decimal("79.00")), ("3 months", 3, Decimal("219.00")), ("1 year", 12, Decimal("799.00"))]


def add_plans(apps, schema_editor):
    Plan = apps.get_model("accounts", "Plan")
    if not Plan.objects.exists():
        for name, months, price in DEFAULTS:
            Plan.objects.create(name=name, months=months, price=price)


class Migration(migrations.Migration):
    dependencies = [("accounts", "0009_plans_and_subscriptions")]
    operations = [migrations.RunPython(add_plans, migrations.RunPython.noop)]
