import datetime

from django.core.management import call_command
from django.utils import timezone
from rest_framework.test import APITestCase

from accounts.models import Client


def seed():
    call_command("seed_demo", verbosity=0)
    # tests run at any hour: make the business day the calendar day
    Client.objects.update(day_change_time=datetime.time(0, 0))


class MotelFlowTests(APITestCase):
    def setUp(self):
        seed()

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
        self.assertIn("overlap", r2.data)
        # clerk confirms: same room rented twice
        r3 = self.client.post("/api/stays/", {**payload, "name": "Second Rental", "phone": "",
                                              "allow_overlap": True}, format="json")
        self.assertEqual(r3.status_code, 201, r3.data)
        dash = self.client.get(f"/api/dashboard/?date={today}").data
        self.assertEqual(sum(1 for s in dash["staying"] if s["room"] == room["id"]), 2)
        self.assertTrue(any(r["id"] == room["id"] for r in dash["rooms"]))

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

    def test_today_report(self):
        self.login("clerk", "clerk123")
        today = timezone.localdate()
        room = next(r for r in self.client.get("/api/rooms/board/").data if not r["occupied"])
        self.client.post("/api/stays/", {
            "room": room["id"], "check_in_date": str(today), "check_in_time": "13:00",
            "check_out_date": str(today + datetime.timedelta(days=2)), "check_out_time": "11:00",
            "num_guests": 1, "rate": "40.00", "name": "Report Guest", "cash": "30", "credit": "10",
        }, format="json")
        r = self.client.get("/api/reports/today/")
        self.assertEqual(r.status_code, 200)
        d = r.data
        self.assertTrue(any(c["guest_name"] == "Report Guest" for c in d["checkins"]))
        self.assertEqual(
            float(d["money"]["collected"]),
            float(d["money"]["cash"]) + float(d["money"]["credit"]),
        )
        mine = self.client.get("/api/reports/today/?mine=1").data
        self.assertTrue(all(c["clerk"] == "Maria" for c in mine["checkins"]))
        # super admin has no motel -> not allowed
        self.client.credentials()
        self.login("superadmin", "admin123")
        self.assertEqual(self.client.get("/api/reports/today/").status_code, 403)

    def test_editable_balance(self):
        """Clerk overrides balance at check-in: difference is stored as an adjustment."""
        self.login("clerk", "clerk123")
        today = timezone.localdate()
        room = next(r for r in self.client.get("/api/rooms/board/").data if not r["occupied"])
        # 2 nights x 50 = 100, paid 60, normal balance 40; clerk sets balance to 25 -> adjustment -15
        r = self.client.post("/api/stays/", {
            "room": room["id"], "check_in_date": str(today), "check_in_time": "13:00",
            "check_out_date": str(today + datetime.timedelta(days=2)), "check_out_time": "11:00",
            "num_guests": 1, "rate": "50.00", "name": "Adj Guest", "cash": "60", "adjustment": "-15",
        }, format="json")
        self.assertEqual(r.status_code, 201, r.data)
        self.assertEqual(r.data["total_amount"], "85.00")
        self.assertEqual(r.data["balance"], "25.00")
        self.assertEqual(r.data["adjustment"], "-15.00")
        bad = self.client.post("/api/stays/", {
            "room": room["id"], "check_in_date": str(today), "check_in_time": "13:00",
            "check_out_date": str(today + datetime.timedelta(days=1)), "check_out_time": "11:00",
            "rate": "50.00", "name": "Neg", "adjustment": "-80", "allow_overlap": True,
        }, format="json")
        self.assertEqual(bad.status_code, 400)

    def test_maintenance_role(self):
        today = timezone.localdate()
        # clerk adds notes
        self.login("clerk", "clerk123")
        room = self.client.get("/api/rooms/").data[0]
        r = self.client.post("/api/notes/", {"date": str(today), "room": room["id"], "text": "Fix lamp"}, format="json")
        self.assertEqual(r.status_code, 201, r.data)
        self.assertEqual(self.client.post("/api/notes/", {"date": str(today), "text": "  "}, format="json").status_code, 400)
        self.assertGreaterEqual(len(self.client.get(f"/api/notes/?date={today}").data), 1)

        # owner creates a maintenance user
        self.client.credentials()
        self.login("owner", "owner123")
        r = self.client.post("/api/users/", {"username": "fixer", "password": "fixer123", "role": "MAINTENANCE"}, format="json")
        self.assertEqual(r.status_code, 201, r.data)

        # maintenance sees only the board
        self.client.credentials()
        user = self.login("fixer", "fixer123")
        self.assertEqual(user["role"], "MAINTENANCE")
        board = self.client.get("/api/maintenance/")
        self.assertEqual(board.status_code, 200)
        self.assertIn("rooms", board.data)
        self.assertTrue(any(n["text"] == "Fix lamp" for r_ in board.data["rooms"] for n in r_["notes"])
                        or any(n["text"] == "Fix lamp" for n in board.data["other_notes"]))
        flat = str(board.data)
        self.assertNotIn("John Carter", flat)      # no guest names
        self.assertNotIn("total", flat)            # no money
        for path in ["/api/stays/", "/api/dashboard/", "/api/reports/today/", "/api/guests/",
                     "/api/rooms/", "/api/notes/", "/api/users/"]:
            self.assertEqual(self.client.get(path).status_code, 403, path)
        self.assertEqual(self.client.post("/api/notes/", {"date": str(today), "text": "x"}, format="json").status_code, 403)

    def test_weekly_and_monthly(self):
        self.login("clerk", "clerk123")
        today = timezone.localdate()
        board = [r for r in self.client.get("/api/rooms/board/").data if not r["occupied"]]
        self.assertIn("weekly_rate", board[0])
        base = {"check_in_date": str(today), "check_in_time": "13:00", "check_out_time": "11:00", "num_guests": 1}

        # weekly: 2 weeks at room-type weekly rate (rate not sent -> default for the type)
        r = self.client.post("/api/stays/", {**base, "room": board[0]["id"], "name": "Weekly Guest",
            "rate_type": "WEEKLY", "periods": 2,
            "check_out_date": str(today + datetime.timedelta(days=14))}, format="json")
        self.assertEqual(r.status_code, 201, r.data)
        self.assertEqual(r.data["periods"], 2)
        self.assertEqual(r.data["num_days"], 14)
        self.assertEqual(r.data["rate"], board[0]["weekly_rate"])
        self.assertEqual(float(r.data["total_amount"]), 2 * float(board[0]["weekly_rate"]))

        # monthly: 1 month, custom rate
        r = self.client.post("/api/stays/", {**base, "room": board[1]["id"], "name": "Monthly Guest",
            "rate_type": "MONTHLY", "periods": 1, "rate": "1000.00",
            "check_out_date": str(today + datetime.timedelta(days=30))}, format="json")
        self.assertEqual(r.status_code, 201, r.data)
        self.assertEqual(r.data["total_amount"], "1000.00")

        # weekly without periods -> worked out from dates (10 nights = 2 weeks)
        r = self.client.post("/api/stays/", {**base, "room": board[2]["id"], "name": "Auto Weeks",
            "rate_type": "WEEKLY", "rate": "300",
            "check_out_date": str(today + datetime.timedelta(days=10))}, format="json")
        self.assertEqual(r.data["periods"], 2)
        self.assertEqual(r.data["total_amount"], "600.00")

        # daily still nights x rate
        r = self.client.post("/api/stays/", {**base, "room": board[3]["id"], "name": "Daily Guest",
            "rate": "50", "check_out_date": str(today + datetime.timedelta(days=3))}, format="json")
        self.assertEqual((r.data["rate_type"], r.data["periods"], r.data["total_amount"]), ("DAILY", 3, "150.00"))

        # occupancy ADR uses nightly value (1000/30), not the monthly rate
        occ = self.client.get(f"/api/reports/occupancy/?start={today}&end={today}").data
        self.assertLess(float(occ["days"][0]["adr"]), 200)

    def test_extra_charges(self):
        # admin sets fees, clerk can read but not change
        self.login("owner", "owner123")
        r = self.client.patch("/api/settings/", {"card_fee_percent": "3.5", "pet_fee": "20",
                                                  "extra_person_fee": "10", "included_guests": 2}, format="json")
        self.assertEqual(r.status_code, 200, r.data)
        self.client.credentials()
        self.login("clerk", "clerk123")
        self.assertEqual(self.client.get("/api/settings/").data["pet_fee"], "20.00")
        self.assertEqual(self.client.patch("/api/settings/", {"pet_fee": "1"}, format="json").status_code, 403)

        today = timezone.localdate()
        room = next(r for r in self.client.get("/api/rooms/board/").data if not r["occupied"])
        # 2 nights x 50 = 100, 1 pet 20, 1 extra person x 2 nights x 10 = 20, card fee 3.50 on 100 card
        r = self.client.post("/api/stays/", {
            "room": room["id"], "check_in_date": str(today), "check_in_time": "13:00",
            "check_out_date": str(today + datetime.timedelta(days=2)), "check_out_time": "11:00",
            "num_guests": 3, "rate": "50", "name": "Fee Guest",
            "pets": 1, "pet_fee": "20", "extra_persons": 1, "extra_person_fee": "20", "card_fee": "3.50",
            "cash": "40", "credit": "100",
        }, format="json")
        self.assertEqual(r.status_code, 201, r.data)
        d = r.data
        self.assertEqual((d["room_charge"], d["charges_total"], d["total_amount"]), ("100.00", "43.50", "143.50"))
        self.assertEqual(d["balance"], "3.50")
        rep = self.client.get(f"/api/reports/checkins/?start={today}&end={today}").data
        self.assertEqual(next(x for x in rep["rows"] if x["id"] == d["id"])["fees"], "43.50")
        bad = self.client.patch(f"/api/stays/{d['id']}/", {"pet_fee": "-5"}, format="json")
        self.assertEqual(bad.status_code, 400)

    def test_dashboard_available_rooms(self):
        self.login("clerk", "clerk123")
        d = self.client.get("/api/dashboard/").data
        avail = [r for r in d["rooms"] if r["available"]]
        self.assertEqual(len(avail), d["stats"]["available"])
        # demo: room 101 guest checks out today and is still in -> available tonight but flagged due_out
        r101 = next(r for r in d["rooms"] if r["number"] == "101")
        self.assertTrue(r101["available"] and r101["due_out"])
        self.assertFalse(next(r for r in d["rooms"] if r["number"] == "201")["available"])

    def test_checkout_and_check_in_again(self):
        self.login("clerk", "clerk123")
        today = timezone.localdate()
        # demo: John Carter in room 101 checks out today
        old = next(s for s in self.client.get("/api/dashboard/").data["checkouts"] if s["room_number"] == "101")
        self.assertEqual(old["status"], "CHECKED_IN")
        r = self.client.post("/api/stays/", {
            "renew_from": old["id"], "room": old["room"], "name": old["guest"]["name"],
            "check_in_date": str(today), "check_in_time": "11:00",
            "check_out_date": str(today + datetime.timedelta(days=3)), "check_out_time": "11:00",
            "num_guests": 2, "rate": old["rate"],
        }, format="json")
        self.assertEqual(r.status_code, 201, r.data)
        new = r.data
        self.assertNotEqual(new["id"], old["id"])
        self.assertEqual(new["renewed_from"], old["id"])
        self.assertEqual(new["guest"]["id"], old["guest"]["id"])     # same guest record, new stay
        old_now = self.client.get(f"/api/stays/{old['id']}/").data
        self.assertEqual(old_now["status"], "CHECKED_OUT")
        self.assertEqual(old_now["renewed_to"], new["id"])

        # renewing early (old stay still has nights left) does not trip the double-booking check
        r2 = self.client.post("/api/stays/", {
            "renew_from": new["id"], "room": new["room"], "name": "x",
            "check_in_date": str(today + datetime.timedelta(days=1)), "check_in_time": "11:00",
            "check_out_date": str(today + datetime.timedelta(days=8)), "check_out_time": "11:00",
            "rate": "300", "rate_type": "WEEKLY", "periods": 1,
        }, format="json")
        self.assertEqual(r2.status_code, 201, r2.data)

    def test_dnr_list(self):
        self.login("clerk", "clerk123")
        # add a past customer straight to DNR
        r = self.client.post("/api/guests/", {"name": "Bad Bob", "phone": "(214) 555-0999", "license_plate": "zz-9 99",
                                              "do_not_rent": True, "dnr_reason": "Damaged room 2024"}, format="json")
        self.assertEqual(r.status_code, 201, r.data)
        self.assertTrue(r.data["do_not_rent"])
        self.assertEqual(r.data["dnr_marked_by_name"], "Maria")
        self.assertIsNotNone(r.data["dnr_marked_at"])

        # same phone in another format -> existing guest is flagged, not duplicated
        r2 = self.client.post("/api/guests/", {"name": "Mike Brown", "phone": "214.555.0122", "do_not_rent": True,
                                               "dnr_reason": "Smoking"}, format="json")
        self.assertEqual(r2.status_code, 200, r2.data)
        self.assertTrue(r2.data["merged"])
        self.assertEqual(self.client.get("/api/guests/?q=Mike Brown").data[0]["dnr_reason"], "Smoking")

        chk = lambda **kw: self.client.get("/api/guests/dnr_check/", kw).data["matches"]
        self.assertEqual(chk(phone="2145550999")[0]["name"], "Bad Bob")
        self.assertEqual(chk(plate="ZZ999")[0]["matched_on"], ["plate"])
        self.assertEqual(chk(name="  bad   bob ")[0]["name"], "Bad Bob")
        self.assertEqual(chk(name="Good Gary", phone="111-222-3333", plate="OK123"), [])

        dnr = self.client.get("/api/guests/?dnr=1").data
        self.assertTrue(any(g["name"] == "Bad Bob" for g in dnr))
        bob = next(g for g in dnr if g["name"] == "Bad Bob")
        r = self.client.patch(f"/api/guests/{bob['id']}/", {"do_not_rent": False}, format="json")
        self.assertFalse(r.data["do_not_rent"])
        self.assertIsNone(r.data["dnr_marked_at"])
        self.assertEqual(chk(phone="2145550999"), [])


class EarlyCheckoutTests(APITestCase):
    """Early checkout + refunds, late fee."""

    def setUp(self):
        seed()
        r = self.client.post("/api/auth/login/", {"username": "clerk", "password": "clerk123"}, format="json")
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {r.data['access']}")
        self.today = timezone.localdate()
        self.free = [r for r in self.client.get("/api/rooms/board/").data if not r["occupied"]]

    def stay(self, i, back, ahead, **extra):
        d = datetime.timedelta
        payload = {"room": self.free[i]["id"], "check_in_date": str(self.today - d(days=back)), "check_in_time": "14:00",
                   "check_out_date": str(self.today + d(days=ahead)), "check_out_time": "11:00",
                   "num_guests": 1, "rate": "50", "name": f"Guest {i}", "allow_overlap": True, **extra}
        r = self.client.post("/api/stays/", payload, format="json")
        self.assertEqual(r.status_code, 201, r.data)
        return r.data

    def test_daily_early_checkout_full_refund(self):
        s = self.stay(0, 2, 3, cash="250")  # 5 nights x 50, paid in full
        q = self.client.get(f"/api/stays/{s['id']}/early_quote/?date={self.today}").data
        self.assertEqual((q["nights_used"], q["nights_unused"], q["new_total"], q["refund_due"]), (2, 3, "100.00", "150.00"))
        r = self.client.post(f"/api/stays/{s['id']}/early_checkout/", {"date": str(self.today), "refund_method": "CASH"}, format="json")
        self.assertEqual(r.status_code, 200, r.data)
        self.assertEqual((r.data["status"], r.data["check_out_date"], r.data["total_amount"]), ("CHECKED_OUT", str(self.today), "100.00"))
        self.assertEqual((r.data["balance"], r.data["refunded"]), ("0.00", "150.00"))
        self.assertEqual(r.data["early"]["original_total"], "250.00")
        # room is free tonight
        dash = self.client.get(f"/api/dashboard/?date={self.today}").data
        self.assertTrue(next(x for x in dash["rooms"] if x["id"] == s["room"])["available"])
        # reports net of refund, typed "Refund"
        col = self.client.get(f"/api/reports/collections/?start={self.today}&end={self.today}").data
        self.assertTrue(any(p["type"] == "Refund" and p["amount"] == "-150.00" for p in col["payments"]))
        self.assertEqual(col["totals"]["refunds"], "150.00")
        tr = self.client.get(f"/api/reports/today/?date={self.today}").data
        self.assertEqual(tr["money"]["refunds"], "150.00")
        # undo restores the booking; refund stays on record so guest owes it back
        r = self.client.post(f"/api/stays/{s['id']}/reopen/", format="json")
        self.assertEqual(r.status_code, 200, r.data)
        self.assertEqual((r.data["status"], r.data["total_amount"], r.data["balance"], r.data["early"]),
                         ("CHECKED_IN", "250.00", "150.00", None))
        self.assertEqual(r.data["check_out_date"], str(self.today + datetime.timedelta(days=3)))

    def test_unpaid_and_partial_and_limits(self):
        s = self.stay(1, 2, 3, cash="60")  # paid 60 of 250
        q = self.client.get(f"/api/stays/{s['id']}/early_quote/?date={self.today}").data
        self.assertEqual((q["refund_due"], q["balance_due"]), ("0.00", "40.00"))
        r = self.client.post(f"/api/stays/{s['id']}/early_checkout/", {"date": str(self.today)}, format="json")
        self.assertEqual((r.data["balance"], r.data["refunded"]), ("40.00", "0.00"))

        s = self.stay(2, 1, 4, credit="250")
        bad = self.client.post(f"/api/stays/{s['id']}/early_checkout/", {"date": str(self.today), "refund_amount": "999"}, format="json")
        self.assertEqual(bad.status_code, 400)
        self.assertIn("refund_amount", bad.data)
        # future / before check-in / not early dates rejected
        for d in (self.today + datetime.timedelta(days=1), self.today - datetime.timedelta(days=5)):
            self.assertEqual(self.client.get(f"/api/stays/{s['id']}/early_quote/?date={d}").status_code, 400)
        # partial refund 100 of 200; guest left with -100 credit, then refund the rest via refund button
        r = self.client.post(f"/api/stays/{s['id']}/early_checkout/",
                             {"date": str(self.today), "refund_amount": "100", "refund_method": "CREDIT"}, format="json")
        self.assertEqual((r.data["total_amount"], r.data["balance"]), ("50.00", "-100.00"))
        self.assertEqual(self.client.post(f"/api/stays/{s['id']}/refund/", {"amount": "150"}, format="json").status_code, 400)
        r = self.client.post(f"/api/stays/{s['id']}/refund/", {"amount": "100", "method": "CREDIT"}, format="json")
        self.assertEqual((r.status_code, r.data["balance"], r.data["refunded"]), (201, "0.00", "200.00"))
        self.assertEqual(self.client.post(f"/api/stays/{s['id']}/refund/", {"amount": "1"}, format="json").status_code, 400)
        # cannot early-checkout twice
        self.assertEqual(self.client.post(f"/api/stays/{s['id']}/early_checkout/", {"date": str(self.today)}, format="json").status_code, 400)

    def test_same_day_minimum_one_night_and_fees(self):
        s = self.stay(3, 0, 3, cash="200", num_guests=3, pet_fee="20", extra_person_fee="30", card_fee="0")
        # 3 x 50 + 20 + 30 = 200
        self.assertEqual(s["total_amount"], "200.00")
        q = self.client.get(f"/api/stays/{s['id']}/early_quote/?date={self.today}").data
        # 1 night charged, extra person 30 -> 10, pet kept
        self.assertEqual((q["nights_used"], q["room_charge"], q["extra_person_fee"], q["new_total"], q["refund_due"]),
                         (1, "50.00", "10.00", "80.00", "120.00"))
        q = self.client.get(f"/api/stays/{s['id']}/early_quote/?date={self.today}&method=NO_REFUND").data
        self.assertEqual(q["refund_due"], "0.00")
        q = self.client.get(f"/api/stays/{s['id']}/early_quote/?date={self.today}&method=CUSTOM&room_charge=500").data
        self.assertEqual(q["room_charge"], "150.00")  # capped at the original

    def test_weekly_methods(self):
        board = self.free[4]  # weekly stay; daily option uses the room type daily rate
        s = self.stay(4, 3, 4, rate_type="WEEKLY", periods=1, rate="210", cash="210")
        q = self.client.get(f"/api/stays/{s['id']}/early_quote/?date={self.today}").data
        daily = float(board["default_rate"])
        self.assertEqual(float(q["options"]["DAILY_RATE"]), min(daily * 3, 210))
        self.assertEqual(q["options"]["PRORATA"], "90.00")
        r = self.client.post(f"/api/stays/{s['id']}/early_checkout/", {"date": str(self.today), "method": "PRORATA"}, format="json")
        self.assertEqual((r.data["total_amount"], r.data["refunded"]), ("90.00", "120.00"))

    def test_late_fee(self):
        s = self.stay(5, 2, 0, cash="100", late_fee="15")
        self.assertEqual(s["total_amount"], "115.00")
        self.assertEqual(s["late_fee"], "15.00")
        s2 = self.stay(6, 2, 0, cash="100")
        r = self.client.post(f"/api/stays/{s2['id']}/checkout/", {"late_fee": "20"}, format="json")
        self.assertEqual((r.data["status"], r.data["late_fee"], r.data["total_amount"], r.data["balance"]),
                         ("CHECKED_OUT", "20.00", "120.00", "20.00"))
        # checkout day is not early
        s3 = self.stay(7, 2, 0, cash="100")
        self.assertEqual(self.client.get(f"/api/stays/{s3['id']}/early_quote/?date={self.today}").status_code, 400)


class SplitPaymentTests(APITestCase):
    def test_cash_and_card_with_fee(self):
        seed()
        r = self.client.post("/api/auth/login/", {"username": "clerk", "password": "clerk123"}, format="json")
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {r.data['access']}")
        today = timezone.localdate()
        room = next(x for x in self.client.get("/api/rooms/board/").data if not x["occupied"])
        s = self.client.post("/api/stays/", {"room": room["id"], "check_in_date": str(today), "check_in_time": "14:00",
            "check_out_date": str(today + datetime.timedelta(days=2)), "check_out_time": "11:00", "num_guests": 1,
            "rate": "50", "name": "Split", "cash": "18"}, format="json").data
        self.assertEqual(s["balance"], "82.00")
        r = self.client.post(f"/api/stays/{s['id']}/payments/", {"cash": "20", "credit": "64.46", "card_fee": "2.46"}, format="json")
        self.assertEqual(r.status_code, 201, r.data)
        self.assertEqual((r.data["card_fee"], r.data["total_amount"], r.data["balance"]), ("2.46", "102.46", "0.00"))
        self.assertEqual(self.client.post(f"/api/stays/{s['id']}/payments/", {"cash": "0", "credit": ""}, format="json").status_code, 400)
        self.assertEqual(self.client.post(f"/api/stays/{s['id']}/payments/", {"cash": "5", "card_fee": "1"}, format="json").status_code, 400)

    def test_edit_balance_at_payment(self):
        seed()
        r = self.client.post("/api/auth/login/", {"username": "clerk", "password": "clerk123"}, format="json")
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {r.data['access']}")
        today = timezone.localdate()
        room = next(x for x in self.client.get("/api/rooms/board/").data if not x["occupied"])
        s = self.client.post("/api/stays/", {"room": room["id"], "check_in_date": str(today), "check_in_time": "14:00",
            "check_out_date": str(today + datetime.timedelta(days=1)), "check_out_time": "11:00", "num_guests": 1,
            "rate": "70", "name": "Adj", "cash": "18"}, format="json").data
        # guest pays 40, clerk waives the remaining 12
        r = self.client.post(f"/api/stays/{s['id']}/payments/", {"cash": "40", "credit": "0", "adjustment_change": "-12"}, format="json")
        self.assertEqual((r.status_code, r.data["adjustment"], r.data["total_amount"], r.data["balance"]), (201, "-12.00", "58.00", "0.00"))
        self.assertEqual(self.client.post(f"/api/stays/{s['id']}/payments/", {"cash": "0", "adjustment_change": "-500"}, format="json").status_code, 400)


class BusinessDayTests(APITestCase):
    """Night Audit and counting money on the day it was received."""

    def setUp(self):
        seed()
        self.today = timezone.localdate()

    def login(self, u, p):
        r = self.client.post("/api/auth/login/", {"username": u, "password": p}, format="json")
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {r.data['access']}")

    def test_auto_change_time(self):
        from . import business
        c = Client.objects.get(name__icontains="sunset")
        c.day_change_time = datetime.time(11, 0)
        tz = timezone.get_current_timezone()
        early = timezone.make_aware(datetime.datetime.combine(self.today, datetime.time(6, 51)), tz)
        late = timezone.make_aware(datetime.datetime.combine(self.today, datetime.time(11, 5)), tz)
        self.assertEqual(business.business_date(c, early), self.today - datetime.timedelta(days=1))
        self.assertEqual(business.business_date(c, late), self.today)

    def test_close_day_and_money_by_day(self):
        self.login("clerk", "clerk123")
        st = self.client.get("/api/business-day/").data
        self.assertEqual(st["business_date"], self.today)
        room = next(x for x in self.client.get("/api/rooms/board/").data if not x["occupied"])
        s = self.client.post("/api/stays/", {"room": room["id"], "check_in_date": str(self.today), "check_in_time": "14:00",
            "check_out_date": str(self.today + datetime.timedelta(days=2)), "check_out_time": "11:00", "num_guests": 1,
            "rate": "35", "name": "Pays Later", "cash": "18"}, format="json").data
        prev = self.client.get("/api/business-day/preview/").data
        self.assertEqual(prev["summary"]["cash"], "18.00")

        # Night Audit: day closes, next day starts right away
        self.assertEqual(self.client.post("/api/business-day/close/", {"date": str(self.today - datetime.timedelta(days=1))}, format="json").status_code, 400)
        r = self.client.post("/api/business-day/close/", {"date": str(self.today)}, format="json")
        self.assertEqual(r.status_code, 201, r.data)
        tomorrow = self.today + datetime.timedelta(days=1)
        self.assertEqual(r.data["business_date"], tomorrow)
        self.assertFalse(r.data["can_close"])   # tomorrow has not started on the calendar
        self.assertEqual(self.client.post("/api/business-day/close/", {"date": str(tomorrow)}, format="json").status_code, 400)
        self.assertEqual(r.data["last_close"]["summary"]["cash"], "18.00")

        # balance paid now counts on the new business day, not the check-in day
        r = self.client.post(f"/api/stays/{s['id']}/payments/", {"cash": "52", "credit": "0"}, format="json")
        self.assertEqual(r.data["payments"][-1]["business_date"], str(tomorrow))
        rep = self.client.get(f"/api/reports/checkins/?start={self.today}&end={self.today}").data
        row = next(x for x in rep["rows"] if x["id"] == s["id"])
        self.assertEqual((row["cash"], row["paid_later"], row["balance"]), ("18.00", "52.00", "0.00"))
        col = self.client.get(f"/api/reports/collections/?start={self.today}&end={tomorrow}").data
        by_day = {str(d["date"]): d["cash"] for d in col["days"]}
        self.assertEqual(by_day.get(str(tomorrow)), "52.00")
        t1 = self.client.get(f"/api/reports/today/?date={self.today}").data
        self.assertEqual(next(x for x in t1["checkins"] if x["id"] == s["id"])["paid_other_days"], "52.00")
        t2 = self.client.get("/api/reports/today/").data   # defaults to the business day
        self.assertEqual(t2["date"], tomorrow)
        self.assertTrue(any(p["stay_id"] == s["id"] and p["amount"] == "52.00" for p in t2["payments"]))
        # dashboard defaults to the business day too
        self.assertEqual(self.client.get("/api/dashboard/").data["date"], tomorrow)

        # reopen: admin only
        self.assertEqual(self.client.post("/api/business-day/reopen/").status_code, 403)
        self.login("owner", "owner123")
        r = self.client.post("/api/business-day/reopen/")
        self.assertEqual((r.status_code, r.data["business_date"]), (200, self.today))
        self.assertEqual(len(self.client.get("/api/business-day/history/").data), 0)


class AddStayTests(APITestCase):
    def test_extend_with_advance(self):
        seed()
        r = self.client.post("/api/auth/login/", {"username": "clerk", "password": "clerk123"}, format="json")
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {r.data['access']}")
        today = timezone.localdate()
        free = [x for x in self.client.get("/api/rooms/board/").data if not x["occupied"]]
        s = self.client.post("/api/stays/", {"room": free[0]["id"], "check_in_date": str(today), "check_in_time": "14:00",
            "check_out_date": str(today + datetime.timedelta(days=2)), "check_out_time": "11:00", "num_guests": 3,
            "rate": "60", "extra_person_fee": "20", "name": "Extender", "cash": "140"}, format="json").data
        self.assertEqual(s["total_amount"], "140.00")
        r = self.client.post(f"/api/stays/{s['id']}/extend/", {"periods": 3, "cash": "120", "credit": "92.70", "card_fee": "2.70"}, format="json")
        self.assertEqual(r.status_code, 200, r.data)
        # 5 nights x 60 + extra person 10/night x 5 + card fee 2.70
        self.assertEqual((r.data["check_out_date"], r.data["num_days"], r.data["total_amount"], r.data["balance"]),
                         (str(today + datetime.timedelta(days=5)), 5, "352.70", "0.00"))
        # room booked later -> asks first
        self.client.post("/api/stays/", {"room": free[0]["id"], "check_in_date": str(today + datetime.timedelta(days=6)), "check_in_time": "14:00",
            "check_out_date": str(today + datetime.timedelta(days=8)), "check_out_time": "11:00", "num_guests": 1,
            "rate": "60", "name": "Next Guest"}, format="json")
        r = self.client.post(f"/api/stays/{s['id']}/extend/", {"periods": 2}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("overlap", r.data)
        r = self.client.post(f"/api/stays/{s['id']}/extend/", {"periods": 2, "allow_overlap": True}, format="json")
        self.assertEqual((r.status_code, r.data["balance"]), (200, "140.00"))
        # weekly adds weeks
        w = self.client.post("/api/stays/", {"room": free[1]["id"], "check_in_date": str(today), "check_in_time": "14:00",
            "check_out_date": str(today + datetime.timedelta(days=7)), "check_out_time": "11:00", "num_guests": 1,
            "rate_type": "WEEKLY", "periods": 1, "rate": "300", "name": "Weekly"}, format="json").data
        r = self.client.post(f"/api/stays/{w['id']}/extend/", {"periods": 1}, format="json")
        self.assertEqual((r.data["periods"], r.data["num_days"], r.data["total_amount"]), (2, 14, "600.00"))
        self.assertEqual(self.client.post(f"/api/stays/{w['id']}/extend/", {"periods": 0}, format="json").status_code, 400)


class PaginationAndHistoryTests(APITestCase):
    def setUp(self):
        seed()
        r = self.client.post("/api/auth/login/", {"username": "clerk", "password": "clerk123"}, format="json")
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {r.data['access']}")
        self.today = timezone.localdate()

    def test_pages(self):
        room = next(x for x in self.client.get("/api/rooms/board/").data if not x["occupied"])
        for i in range(8):
            self.client.post("/api/stays/", {"room": room["id"], "check_in_date": str(self.today - datetime.timedelta(days=20 + 2 * i)),
                "check_in_time": "14:00", "check_out_date": str(self.today - datetime.timedelta(days=19 + 2 * i)), "check_out_time": "11:00",
                "num_guests": 1, "rate": "50", "name": f"Old {i}", "cash": "10" if i % 2 else "50", "allow_overlap": True}, format="json")
        total = len(self.client.get("/api/stays/").data)
        r = self.client.get("/api/stays/?page=1&page_size=5").data
        self.assertEqual((r["count"], r["page"], len(r["results"])), (total, 1, min(5, total)))
        self.assertEqual(r["pages"], (total + 4) // 5)
        last = self.client.get(f"/api/stays/?page=999&page_size=5").data
        self.assertEqual(last["page"], r["pages"])
        if r["pages"] > 1:
            ids = [x["id"] for x in r["results"]] + [x["id"] for x in self.client.get("/api/stays/?page=2&page_size=5").data["results"]]
            self.assertEqual(len(ids), len(set(ids)))  # no repeats across pages
        self.assertGreater(total, 5)
        b = self.client.get("/api/stays/?page=1&page_size=5&has_balance=1").data
        self.assertTrue(all(float(x["balance"]) > 0 for x in b["results"]))
        self.assertAlmostEqual(float(b["owed"]), sum(float(x["balance"]) for x in self.client.get("/api/stays/?has_balance=1").data), places=2)

    def test_payment_history(self):
        room = next(x for x in self.client.get("/api/rooms/board/").data if not x["occupied"])
        s = self.client.post("/api/stays/", {"room": room["id"], "check_in_date": str(self.today), "check_in_time": "14:00",
            "check_out_date": str(self.today + datetime.timedelta(days=2)), "check_out_time": "11:00", "num_guests": 1,
            "rate": "50", "name": "History Harry", "phone": "555-1212", "cash": "30"}, format="json").data
        self.client.post(f"/api/stays/{s['id']}/payments/", {"cash": "0", "credit": "70"}, format="json")
        self.assertEqual(self.client.get("/api/reports/payment-history/").status_code, 400)
        r = self.client.get("/api/reports/payment-history/?name=harry").data
        self.assertEqual(r["count"], 1)
        row = r["rows"][0]
        self.assertEqual((row["guest"]["phone"], row["paid"], row["balance"], len(row["payments"])), ("555-1212", "100.00", "0.00", 2))
        self.assertEqual([x["type"] for x in row["payments"]], ["Check-in", "Balance payment"])
        r = self.client.get(f"/api/reports/payment-history/?room={room['number']}&start={self.today}&end={self.today}").data
        self.assertTrue(any(x["id"] == s["id"] for x in r["rows"]))
        r = self.client.get(f"/api/reports/payment-history/?room={room['number']}&start={self.today + datetime.timedelta(days=5)}").data
        self.assertFalse(any(x["id"] == s["id"] for x in r["rows"]))
