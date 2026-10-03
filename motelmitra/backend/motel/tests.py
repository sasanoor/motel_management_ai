import datetime

from django.core.management import call_command
from django.utils import timezone
from rest_framework.test import APITestCase


class MotelFlowTests(APITestCase):
    def setUp(self):
        call_command("seed_demo", verbosity=0)

    def login(self, username, password):
        r = self.client.post("/api/auth/login/", {"username": username, "password": password}, format="json")
        self.assertEqual(r.status_code, 200, r.data)
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {r.data['access']}")
        return r.data["user"]

    def test_super_admin_onboards_client(self):
        self.login("superadmin", "admin123")
        r = self.client.post("/api/clients/", {
            "name": "Blue Inn", "city": "Austin", "state": "TX",
            "admin_username": "blueowner", "admin_password": "secret12",
        }, format="json")
        self.assertEqual(r.status_code, 201, r.data)
        self.client.credentials()
        user = self.login("blueowner", "secret12")
        self.assertEqual(user["role"], "CLIENT_ADMIN")
        # new motel sees none of Sunset Motel's data
        self.assertEqual(self.client.get("/api/rooms/").data, [])

    def test_roles(self):
        self.login("clerk", "clerk123")
        self.assertEqual(self.client.get("/api/users/").status_code, 403)
        self.assertEqual(self.client.post("/api/room-types/", {"name": "X", "default_rate": 10}).status_code, 403)
        self.assertEqual(self.client.get("/api/clients/").status_code, 403)
        self.assertEqual(self.client.get("/api/rooms/").status_code, 200)

    def test_checkin_payment_delete_restore(self):
        self.login("clerk", "clerk123")
        today = timezone.localdate()
        room = next(r for r in self.client.get("/api/rooms/board/").data if not r["occupied"])
        payload = {
            "room": room["id"], "check_in_date": str(today), "check_in_time": "14:00",
            "check_out_date": str(today + datetime.timedelta(days=3)), "check_out_time": "11:00",
            "num_guests": 2, "rate": "50.00", "name": "Test Guest", "phone": "999-000-1111",
            "license_plate": "TST123", "cash": "60", "credit": "40", "do_not_rent": False,
        }
        r = self.client.post("/api/stays/", payload, format="json")
        self.assertEqual(r.status_code, 201, r.data)
        stay = r.data
        self.assertEqual(stay["num_days"], 3)
        self.assertEqual(stay["total_amount"], "150.00")
        self.assertEqual(stay["balance"], "50.00")

        # double booking blocked
        r2 = self.client.post("/api/stays/", {**payload, "name": "Other"}, format="json")
        self.assertEqual(r2.status_code, 400)

        # balance payment
        r = self.client.post(f"/api/stays/{stay['id']}/payments/", {"amount": "50", "method": "CASH"}, format="json")
        self.assertEqual(r.status_code, 201, r.data)
        self.assertEqual(r.data["balance"], "0.00")

        # reflects in check-in report for that date
        rep = self.client.get(f"/api/reports/checkins/?start={today}&end={today}").data
        row = next(x for x in rep["rows"] if x["id"] == stay["id"])
        self.assertEqual(row["cash"], "110.00")
        self.assertEqual(row["balance"], "0.00")

        # clerk cannot delete
        self.assertEqual(self.client.delete(f"/api/stays/{stay['id']}/").status_code, 403)

        self.client.credentials()
        self.login("owner", "owner123")
        self.assertEqual(self.client.delete(f"/api/stays/{stay['id']}/").status_code, 204)
        self.assertTrue(any(s["id"] == stay["id"] for s in self.client.get("/api/stays/deleted/").data))
        self.assertEqual(self.client.post(f"/api/stays/{stay['id']}/restore/").status_code, 200)
        self.assertEqual(self.client.get(f"/api/stays/{stay['id']}/").status_code, 200)

    def test_dnr_and_dashboard_and_reports(self):
        self.login("clerk", "clerk123")
        r = self.client.get("/api/guests/check/?plate=bad0001")
        self.assertTrue(r.data and r.data[0]["do_not_rent"])
        d = self.client.get("/api/dashboard/").data
        self.assertIn("checkouts", d)
        self.assertGreaterEqual(d["stats"]["occupied"], 1)
        for path in ["collections", "outstanding", "occupancy"]:
            self.assertEqual(self.client.get(f"/api/reports/{path}/").status_code, 200)
