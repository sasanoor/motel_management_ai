from django.db import migrations


def mark(apps, schema_editor):
    """Payments taken with "+ Stay" before this version were saved as plain payments with this default note."""
    Payment = apps.get_model("motel", "Payment")
    Payment.objects.filter(kind="PAYMENT", is_initial=False, notes__startswith="Advance for added stay").update(kind="STAYOVER")


class Migration(migrations.Migration):
    dependencies = [("motel", "0020_check_method_stayover")]
    operations = [migrations.RunPython(mark, migrations.RunPython.noop)]
