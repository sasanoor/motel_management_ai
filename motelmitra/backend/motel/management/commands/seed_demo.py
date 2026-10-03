"""
python manage.py seed_demo

Creates a demo super admin, one motel with a client admin and a clerk,
room types, rooms and a few stays. Safe to run more than once.
"""
import datetime
from decimal import Decimal

from django.core.management.base import BaseCommand
from django.utils import timezone

from accounts.models import Client, User
from motel.models import Guest, Payment, Room, RoomType, Stay


class Command(BaseCommand):
    help = "Load demo data"

    def handle(self, *args, **opts):
        if not User.objects.filter(username="superadmin").exists():
            User.objects.create_superuser("superadmin", "", "admin123")

        client, _ = Client.objects.get_or_create(
            name="Sunset Motel",
            defaults={"address": "100 Highway 66", "city": "Amarillo", "state": "TX",
                      "zip_code": "79101", "phone": "806-555-0100"},
        )
        admin, created = User.objects.get_or_create(
            username="owner", defaults={"client": client, "role": User.CLIENT_ADMIN, "first_name": "Raj"}
        )
        if created:
            admin.set_password("owner123")
            admin.save()
        clerk, created = User.objects.get_or_create(
            username="clerk", defaults={"client": client, "role": User.CLIENT_USER, "first_name": "Maria"}
        )
        if created:
            clerk.set_password("clerk123")
            clerk.save()

        types = {}
        for name, rate in [("King", 69), ("Queen", 59), ("Double", 75), ("Suite", 110),
                           ("Jacuzzi", 129), ("Handicap", 59)]:
            types[name], _ = RoomType.objects.get_or_create(
                client=client, name=name, defaults={"default_rate": Decimal(rate)}
            )
        layout = {"King": range(101, 106), "Queen": range(106, 111), "Double": range(201, 206),
                  "Suite": [206, 207], "Jacuzzi": [208], "Handicap": [100]}
        for tname, nums in layout.items():
            for n in nums:
                Room.objects.get_or_create(client=client, number=str(n), defaults={"room_type": types[tname]})

        if Stay.objects.filter(client=client).exists():
            self.stdout.write(self.style.SUCCESS("Demo data already present."))
            return

        today = timezone.localdate()
        now = timezone.now()
        samples = [
            ("John Carter", "512-555-0141", "ABC1234", "Ford F-150", "101", -2, 0, 40, 98, False),
            ("Linda Moore", "512-555-0177", "XYZ9876", "Toyota Camry", "106", -1, 2, 59, 0, False),
            ("Mike Brown", "214-555-0122", "TRK4455", "Chevy Silverado", "201", 0, 7, 200, 0, False),
            ("Sara Lee", "806-555-0193", "LEE2020", "Honda Civic", "208", 0, 1, 0, 129, False),
            ("Tom Hardy", "806-555-0111", "BAD0001", "Dodge Ram", "103", -5, -3, 50, 0, True),
        ]
        for name, phone, plate, car, room_no, din, dout, cash, credit, dnr in samples:
            guest = Guest.objects.create(
                client=client, name=name, phone=phone, license_plate=plate, car=car,
                address="12 Main St", city="Amarillo", state="TX", zip_code="79101", do_not_rent=dnr,
            )
            room = Room.objects.get(client=client, number=room_no)
            stay = Stay.objects.create(
                client=client, guest=guest, room=room,
                check_in_date=today + datetime.timedelta(days=din), check_in_time=datetime.time(15, 0),
                check_out_date=today + datetime.timedelta(days=dout), num_guests=2,
                rate=room.room_type.default_rate, clerk=clerk,
                status=Stay.CHECKED_OUT if dout < 0 else Stay.CHECKED_IN,
                checked_out_at=now + datetime.timedelta(days=dout) if dout < 0 else None,
                comments="Demo record",
            )
            for amt, method in ((cash, Payment.CASH), (credit, Payment.CREDIT)):
                if amt:
                    Payment.objects.create(stay=stay, amount=Decimal(amt), method=method,
                                           paid_at=now + datetime.timedelta(days=din), clerk=clerk, is_initial=True)

        self.stdout.write(self.style.SUCCESS(
            "Demo data loaded. Logins: superadmin/admin123, owner/owner123, clerk/clerk123"
        ))
