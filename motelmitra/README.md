# MotelMitra

Motel management system. Django REST + MySQL backend, React (Vite) frontend.

## Features

| Area | What it does |
|---|---|
| Roles | Super Admin onboards motels (clients). Client Admin manages users, rooms, room types, rates, deleted guests. Client User checks in guests and takes payments. Maintenance sees only the day's checkout rooms and maintenance notes |
| Guest onboarding | Room, check-in/out date and time (checkout 11 AM default), guests, days, name, address, city, state, zip, car, plate, phone, cash, credit, balance, clerk (auto), comments, do not rent |
| Room rates | Daily, weekly and monthly rate per room type. At check-in pick Rent by Daily / Weekly / Monthly; rate pre-fills, checkout date is calculated, clerk can edit. Total = rate × nights / weeks / months |
| Home screen | Date picker, today's checkouts, all guests staying on a date, occupancy and open balance stats, one-click checkout |
| Extra charges | Pets (per pet, per stay), extra persons (per person, per night above included guests) card fee (% of card amount) and late fee (one click "Apply late fee", or offered at checkout when the guest is past checkout time). Defaults set in Charges & Fees, clerk can override at check-in. "Put balance on card" works out the card amount including the fee |
| Do Not Rent | DNR List menu to add past customers directly (name, phone, plate, reason). Check-in has a Check DNR list button and checks automatically before saving; phone matches in any format, plate ignores spaces/dashes. Clerk decides. Returning guests autofill |
| Early checkout & refunds | Checking out before the booked date opens an early checkout: pick the leaving date (same day = 1 night) and how to charge: nights used × daily rate (capped at the original charge), pro-rata (weekly / monthly), no refund, or a custom amount. Extra person fee is cut to the nights used; pet, card, late fees and discounts are kept. Shows new total, refund due or balance still owed; refund full or part, by cash or card. Room is free right away. Undo restores the booking (refund stays on record). Guests who overpaid get a Refund button. Refunds show as negative rows in Collections and Today's Report |
| Night Audit (business day) | "Today" in the app is the business day, shown in the sidebar. It changes on its own at the day change time (default 11:00 AM, set by the admin on the Night Audit page), or right away when the front desk runs Night Audit (Close day). Closing saves the day's totals; the admin can reopen the last closed day. Every payment is counted on the business day it was taken |
| Room sheet money | Cash and Credit columns show money taken on the sheet's date. Payments from earlier days show as Paid / Part paid, so nothing is counted twice. Totals row at the bottom: Total = check-ins on that date |
| Add stay | Room sheet and guest page: guest stays longer (pays in advance). Pick extra nights / weeks / months at the same rate, new checkout shown, take cash / card now. Same entry; asks first if the room is booked later |
| Balance payments | List of guests who owe money. Each payment adds to previous ones and rolls into the original check-in date report |
| Delete / recover | Client admin soft-deletes guests; separate "Deleted Guests" menu to recover |
| Reports | Daily check-ins, collections (cash vs credit), outstanding balances, occupancy. CSV export and print |
| Multi-tenant | Every motel only sees its own data |
| v2 ready | `Guest.license_card` field already exists for license card upload |

## Project structure

```
motelmitra/
  backend/          Django project
    config/         settings, urls
    accounts/       Client (motel), User, roles, login
    motel/          RoomType, Room, Guest, Stay, Payment, dashboard, reports
  frontend/         React app (Vite)
    src/pages/      screens
    src/components/ layout, tables, modals
```

## Start / stop with one click

| OS | Start | Stop |
|---|---|---|
| Windows | double-click `start_app.bat` | double-click `stop_app.bat` |
| Mac / Linux | `./start_app.sh` | `./stop_app.sh` |

The start script checks Python and Node, installs packages on first run, applies database updates,
starts backend and frontend in the background, waits until both respond, then opens the browser.
It detects this PC's IPv4 address on every start and serves the app on both:

| Where | Address |
|---|---|
| This PC | http://localhost:5173 |
| Phones / tablets / PCs on the same WiFi | http://<detected IP>:5173 (also saved in `app_links.txt`) |

On Windows it also adds firewall rules for ports 5173 and 8000 (run `start_app.bat` once as administrator for this).
Set `LAN=0` at the top of the script to run on this PC only.

Logs go to the `logs` folder, one file per day (older than 30 days are deleted automatically):

| File | Contains |
|---|---|
| `logs/start_app_YYYY-MM-DD.txt` | Start/stop steps, errors, package installs, database updates |
| `logs/backend_YYYY-MM-DD.txt` | Django: every API request, errors and tracebacks |
| `logs/frontend_YYYY-MM-DD.txt` | React / Vite server output |

You still need MySQL running and `backend/.env` filled in (first-time setup below).

## Setup

You need Python 3.10+, Node 18+, MySQL 8.

### 1. Database

```sql
CREATE DATABASE motelmitra CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'motelmitra_user'@'localhost' IDENTIFIED BY 'YourStrongPassword';
GRANT ALL PRIVILEGES ON motelmitra.* TO 'motelmitra_user'@'localhost';
FLUSH PRIVILEGES;
```

### 2. Backend

```bash
cd backend
pip install -r requirements.txt
copy .env.example .env        # Windows   (Mac/Linux: cp .env.example .env)
# edit .env: set DB_PASSWORD and TIME_ZONE
python manage.py migrate
python manage.py seed_demo    # optional demo data
python manage.py createsuperuser   # skip if you used seed_demo
python manage.py runserver
```

If `mysqlclient` will not install on Windows, run `pip install pymysql` and add these two lines at the top of `backend/config/__init__.py`:

```python
import pymysql
pymysql.install_as_MySQLdb()
```

No MySQL yet? Set `DB_ENGINE=sqlite` in `.env` to try the app on SQLite.

### 3. Frontend (new terminal)

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173

### Demo logins (after `seed_demo`)

| Role | Username | Password |
|---|---|---|
| Super Admin | superadmin | admin123 |
| Client Admin | owner | owner123 |
| Client User | clerk | clerk123 |
| Maintenance | maint | maint123 |

Change these before going live.

## Tests

```bash
cd backend
python manage.py test motel
```

## API summary

| Endpoint | Who |
|---|---|
| `POST /api/auth/login/`, `/api/auth/refresh/`, `GET /api/auth/me/` | All |
| `/api/clients/` (+ `/{id}/users/`) | Super admin |
| `/api/users/` | Client admin |
| `/api/room-types/`, `/api/rooms/` (+ `/rooms/board/?date=`) | Staff read, client admin write |
| `/api/stays/` check-ins; `/{id}/payments/`, `/{id}/checkout/` (optional `late_fee`), `/{id}/reopen/`, `/{id}/early_quote/?date=&method=`, `/{id}/early_checkout/`, `/{id}/refund/` | Staff |
| `DELETE /api/stays/{id}/`, `/api/stays/deleted/`, `/{id}/restore/` | Client admin |
| `/api/guests/` (+ `/check/?phone=&plate=`) | Staff |
| `/api/dashboard/?date=` | Staff |
| `/api/business-day/` (+ `preview/`, `close/`, `history/`, `reopen/` admin) | Staff (maintenance can read) |
| `/api/reports/checkins|collections|occupancy/?start=&end=`, `/api/reports/outstanding/` | Staff, super admin with `?client=` |

## Updating to a new version

1. Copy the new files over the old folder (keep `backend\.env` and your database).
2. Double-click **start_app.bat**. If the old version is still running it is restarted automatically and database updates are applied.

If the screens ever show a red "server is still running the old version" bar, run **stop_app.bat** then **start_app.bat**.

## Going live (short version)

1. `.env`: `DEBUG=False`, long random `SECRET_KEY`, real `ALLOWED_HOSTS` and `CORS_ALLOWED_ORIGINS`.
2. `npm run build` and serve `frontend/dist` with Nginx; proxy `/api` to Gunicorn running Django.
3. `python manage.py collectstatic` for the Django admin.
4. HTTPS (Let's Encrypt).
