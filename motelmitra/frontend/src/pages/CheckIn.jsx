import { useEffect, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import api, { errorText } from '../api'
import { useAuth } from '../auth'
import { PhotoUploader } from '../components/Photos'
import PaymentList from '../components/PaymentList'
import RoomPicker from '../components/RoomPicker'
import { confirmBox } from '../confirm'
import { Alert, Modal, PageHead } from '../components/ui'
import {
  RATE_TYPES, addDays, addMonths, daysBetween, fmtDate, money, monthsBetween, nowTime, num, periodText,
  fullName, nameParts, rateFor, rateTypeInfo, todayISO, weekendNights,
} from '../utils'

const blank = (room = '', date = todayISO()) => ({
  room,
  check_in_date: date,
  check_in_time: nowTime(),
  check_out_date: addDays(date, 1),
  check_out_time: '11:00',
  num_guests: 1,
  rate_type: 'DAILY',
  weekend_rate: '',
  periods: 1,          // weeks or months when renting weekly / monthly
  rate: '',
  first_name: '', middle_name: '', last_name: '', address: '', city: '', state: '', zip_code: '',
  phone: '', car: '', license_plate: '', dl_number: '',
  do_not_rent: false,
  cash: '', credit: '', check: '',
  comments: '',
  adjustment: 0,
  // extra charges: null = use the motel's default (auto), a number = clerk typed it
  pets: 0,
  pet_fee: null,
  extra_persons: null,
  extra_person_fee: null,
  card_fee: null,
  late_fee: 0,         // opt-in: clerk applies the motel's late fee or types one
  early_checkin_fee: 0, // opt-in, same as late fee
  guest_id: null,
})

export default function CheckIn() {
  const { id } = useParams()
  const editing = Boolean(id)
  const { user } = useAuth()
  const navigate = useNavigate()
  const [params] = useSearchParams()

  // Opened from the Room sheet: /check-in?room=<id>&date=<YYYY-MM-DD>
  const [f, setF] = useState(() => blank(params.get('room') || '', params.get('date') || todayISO()))
  const [overlap, setOverlap] = useState(null)     // same room rented twice
  const [board, setBoard] = useState([])
  const [match, setMatch] = useState(null)       // returning guest suggestion
  const [dnrHit, setDnrHit] = useState(null)     // do-not-rent guest found
  const [dnrAck, setDnrAck] = useState(false)
  const [dnrResult, setDnrResult] = useState(null) // { key, checked, matches } from "Check DNR list"
  const [dnrBusy, setDnrBusy] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [originalRoom, setOriginalRoom] = useState(null)
  const [paidBefore, setPaidBefore] = useState(0)      // edit mode: payments already taken
  const [stayNow, setStayNow] = useState(null)          // edit mode: the saved stay (payments list)
  const [balanceText, setBalanceText] = useState(null) // text while the clerk types a balance
  const [fees, setFees] = useState(null)               // motel's Charges & Fees settings
  const renewId = !editing ? params.get('renew') : null  // "Check out & check in again"
  const [renewOf, setRenewOf] = useState(null)          // the stay being continued
  const [carry, setCarry] = useState(true)               // add the old stay's balance to this check-in
  const [carriedBefore, setCarriedBefore] = useState(0)  // editing: balance brought in when it was created
  // DL photos: { DL_FRONT, DL_BACK } taken on this form; reused = returning guest's last DL on file
  const [dl, setDl] = useState({ DL_FRONT: null, DL_BACK: null })
  const [reused, setReused] = useState({})
  // extra guests on the same check-in: [{ key, id?, name, dl_number, dl: { DL_FRONT, DL_BACK } }]
  const [extras, setExtras] = useState([])
  const addExtra = () => setExtras((x) => [...x, { key: `n${Date.now()}`, name: '', dl_number: '', dl: { DL_FRONT: null, DL_BACK: null } }])
  const setExtra = (key, patch) => setExtras((x) => x.map((g) => (g.key === key ? { ...g, ...patch } : g)))

  // edit: the stay's own DL photos
  useEffect(() => {
    if (!editing) return
    api.get('/photos/', { params: { stay: id, kind: 'DL' } }).then(({ data }) => {
      const out = { DL_FRONT: null, DL_BACK: null }
      data.filter((p) => !p.extra_guest).forEach((p) => { out[p.kind] = p })
      setDl(out)
    }).catch(() => {})
  }, [editing, id])

  // returning guest: show their last DL photo; it is copied into this stay when saved
  useEffect(() => {
    if (editing || !f.guest_id) return
    api.get('/photos/guest_last_dl/', { params: { guest: f.guest_id } }).then(({ data }) => {
      const out = {}
      data.forEach((p) => { out[p.kind] = p })
      setReused(out)
    }).catch(() => {})
  }, [editing, f.guest_id])

  function addDl(ph) {
    const old = dl[ph.kind]
    if (old && old.id !== ph.id && editing) api.delete(`/photos/${old.id}/`).catch(() => {})  // replaced
    setDl((p) => ({ ...p, [ph.kind]: ph }))
  }
  function removeDl(ph) {
    api.delete(`/photos/${ph.id}/`).catch(() => {})
    setDl((p) => ({ ...p, [ph.kind]: null }))
  }

  useEffect(() => { api.get('/settings/').then((r) => setFees(r.data)).catch(() => {}) }, [])

  const set = (k) => (e) => {
    const v = e?.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e
    setF((p) => ({ ...p, [k]: v }))
  }

  // load existing stay when editing
  useEffect(() => {
    if (!editing) return
    api.get(`/stays/${id}/`).then(({ data: s }) => {
      setOriginalRoom(s.room)
      setPaidBefore(num(s.amount_paid))
      setStayNow(s)
      setExtras((s.extra_guests || []).map((g) => {
        const dlx = { DL_FRONT: null, DL_BACK: null }
        g.photos.forEach((ph) => { dlx[ph.kind] = { ...ph, kind_label: `${ph.kind === 'DL_FRONT' ? 'DL front' : 'DL back'} · ${g.name}` } })
        return { key: `e${g.id}`, id: g.id, name: g.name, dl_number: g.dl_number, dl: dlx }
      }))
      setCarriedBefore(Math.max(num(s.balance_carried), 0))
      setF({
        ...blank(),
        room: s.room,
        check_in_date: s.check_in_date, check_in_time: s.check_in_time.slice(0, 5),
        check_out_date: s.check_out_date, check_out_time: s.check_out_time.slice(0, 5),
        num_guests: s.num_guests, rate: s.rate, weekend_rate: num(s.weekend_rate) ? s.weekend_rate : '', comments: s.comments, adjustment: num(s.adjustment),
        rate_type: s.rate_type || 'DAILY', periods: s.periods || 1,
        pets: s.pets || 0, extra_persons: s.extra_persons ?? 0, pet_fee: num(s.pet_fee),
        extra_person_fee: num(s.extra_person_fee), card_fee: num(s.card_fee), late_fee: num(s.late_fee), early_checkin_fee: num(s.early_checkin_fee),
        ...nameParts(s.guest), address: s.guest.address, city: s.guest.city, state: s.guest.state,
        zip_code: s.guest.zip_code, phone: s.guest.phone, car: s.guest.car,
        license_plate: s.guest.license_plate, dl_number: s.guest.dl_number || '', do_not_rent: s.guest.do_not_rent, guest_id: s.guest.id,
      })
      setDnrAck(true)
    }).catch((e) => setErr(errorText(e)))
  }, [editing, id])

  // Check out & check in again: copy guest, room, rent type and rate into a new check-in starting today
  useEffect(() => {
    if (!renewId) return
    api.get(`/stays/${renewId}/`).then(({ data: s }) => {
      setRenewOf(s)
      setOriginalRoom(s.room) // the guest's own room is not "occupied" for this check-in
      const start = todayISO()
      const type = s.rate_type || 'DAILY'
      const n = type === 'DAILY' ? Math.max(s.num_days || 1, 1) : Math.max(s.periods || 1, 1)
      const end = type === 'WEEKLY' ? addDays(start, 7 * n) : type === 'MONTHLY' ? addMonths(start, n) : addDays(start, n)
      setF({
        ...blank(String(s.room), start),
        check_out_date: end, check_out_time: s.check_out_time.slice(0, 5),
        rate_type: type, periods: n, rate: s.rate, weekend_rate: num(s.weekend_rate) ? s.weekend_rate : '', num_guests: s.num_guests, pets: s.pets || 0,
        ...nameParts(s.guest), address: s.guest.address, city: s.guest.city, state: s.guest.state,
        zip_code: s.guest.zip_code, phone: s.guest.phone, car: s.guest.car,
        license_plate: s.guest.license_plate, dl_number: s.guest.dl_number || '', do_not_rent: s.guest.do_not_rent, guest_id: s.guest.id,
      })
      setDnrAck(true)
    }).catch((e) => setErr(errorText(e)))
  }, [renewId])

  // rooms + their status for the check-in date
  useEffect(() => {
    api.get('/rooms/board/', { params: { date: f.check_in_date } }).then((r) => {
      setBoard(r.data)
      // pre-fill the rate when the room came from the Room sheet
      setF((p) => {
        if (!p.room || p.rate) return p
        const room = r.data.find((x) => String(x.id) === String(p.room))
        return room ? { ...p, rate: rateFor(room, p.rate_type) } : p
      })
    }).catch(() => {})
  }, [f.check_in_date])

  const days = Math.max(daysBetween(f.check_in_date, f.check_out_date), 1)
  const rt = rateTypeInfo(f.rate_type)
  const periods = f.rate_type === 'DAILY' ? days : Math.max(num(f.periods), 1)
  // daily stays: Friday and Saturday nights at the weekend rate (blank = same as the daily rate)
  const wkNights = f.rate_type === 'DAILY' && num(f.weekend_rate) > 0 ? weekendNights(f.check_in_date, days) : 0
  const roomCharge = num(f.rate) * (periods - wkNights) + num(f.weekend_rate) * wkNights
  const selectedRoom = board.find((x) => String(x.id) === String(f.room))

  // ---- extra charges (pets, extra persons, card fee)
  const r2 = (n) => Math.round(n * 100) / 100
  const included = fees?.included_guests ?? 2
  const cardPct = num(fees?.card_fee_percent)
  const extraPersons = f.extra_persons ?? Math.max(num(f.num_guests) - included, 0)
  const petFee = f.pet_fee ?? r2(num(f.pets) * num(fees?.pet_fee))
  const extraFee = f.extra_person_fee ?? r2(extraPersons * num(fees?.extra_person_fee) * days)
  const cardFee = f.card_fee ?? (editing ? 0 : r2((num(f.credit) * cardPct) / 100))
  const lateFee = num(f.late_fee)
  const earlyFee = num(f.early_checkin_fee)
  const charges = petFee + extraFee + cardFee + lateFee + earlyFee

  // Check in again: the old stay's unpaid balance, added to this check-in when the clerk says Yes
  const oldOwed = renewOf ? Math.max(r2(num(renewOf.balance)), 0) : 0
  const carried = editing ? carriedBefore : (carry ? oldOwed : 0)
  const total = roomCharge + charges + num(f.adjustment) + carried
  const paidNow = editing ? paidBefore : num(f.cash) + num(f.credit) + num(f.check)
  const balance = total - paidNow

  // Put the rest on the card, including the card fee on that amount.
  function cardForBalance() {
    const due = roomCharge + petFee + extraFee + lateFee + earlyFee + num(f.adjustment) + carried - num(f.cash) - num(f.check)
    if (due <= 0) return
    // auto fee: card amount c must cover due + c × pct  ->  c = due / (1 - pct)
    const credit = f.card_fee == null ? due / (1 - cardPct / 100) : due + num(f.card_fee)
    setF((p) => ({ ...p, credit: r2(credit).toFixed(2) }))
  }

  // Put the rest in cash (card amount and its fee stay as they are).
  function cashForBalance() {
    const due = roomCharge + charges + num(f.adjustment) + carried - num(f.credit) - num(f.check)
    setF((p) => ({ ...p, cash: Math.max(r2(due), 0).toFixed(2) }))
  }

  // Put the rest in a check (cash and card stay as they are).
  function checkForBalance() {
    const due = roomCharge + charges + num(f.adjustment) + carried - num(f.credit) - num(f.cash)
    setF((p) => ({ ...p, check: Math.max(r2(due), 0).toFixed(2) }))
  }

  // a fee input: shows the auto value until the clerk types one; ↺ goes back to auto
  const feeValue = (key, auto) => (f[key] ?? auto)
  const setFee = (key) => (e) => setF((p) => ({ ...p, [key]: e.target.value === '' ? 0 : Number(e.target.value) }))
  const resetFee = (key) => setF((p) => ({ ...p, [key]: null }))

  // Clerk types a balance: keep rate and payments, store the difference as an adjustment.
  function editBalance(e) {
    const text = e.target.value
    setBalanceText(text)
    if (text === '' || isNaN(Number(text))) return
    const adj = Number(text) - (roomCharge + charges + carried - paidNow)
    setF((p) => ({ ...p, adjustment: Math.round(adj * 100) / 100 }))
  }

  function pickRoom(r) {
    setF((p) => ({
      ...p, room: String(r.id), rate: !editing || !p.rate ? rateFor(r, p.rate_type) : p.rate,
      weekend_rate: !editing ? (num(r.weekend_rate) ? Number(r.weekend_rate).toFixed(2) : '') : p.weekend_rate,
    }))
  }

  // checkout date for a count of nights / weeks / months
  const checkoutFor = (start, type, n) =>
    type === 'WEEKLY' ? addDays(start, 7 * n) : type === 'MONTHLY' ? addMonths(start, n) : addDays(start, n)

  function setRateType(type) {
    setF((p) => {
      const n = type === 'DAILY' ? Math.max(daysBetween(p.check_in_date, p.check_out_date), 1) : 1
      return {
        ...p,
        rate_type: type,
        periods: n,
        check_out_date: type === 'DAILY' ? p.check_out_date : checkoutFor(p.check_in_date, type, 1),
        rate: selectedRoom ? rateFor(selectedRoom, type) : p.rate,
      }
    })
  }

  function setCheckIn(e) {
    const start = e.target.value
    if (!start) return
    setF((p) => {
      const n = p.rate_type === 'DAILY' ? Math.max(daysBetween(p.check_in_date, p.check_out_date), 1) : Math.max(num(p.periods), 1)
      return { ...p, check_in_date: start, check_out_date: checkoutFor(start, p.rate_type, n) }
    })
  }

  function setCheckOut(e) {
    const end = e.target.value
    if (!end) return
    setF((p) => {
      const nights = Math.max(daysBetween(p.check_in_date, end), 1)
      const n = p.rate_type === 'WEEKLY' ? Math.ceil(nights / 7) : p.rate_type === 'MONTHLY' ? monthsBetween(p.check_in_date, end) : nights
      return { ...p, check_out_date: end, periods: n }
    })
  }

  function setCount(e) {
    const n = Math.max(parseInt(e.target.value || '1', 10), 1)
    setF((p) => ({ ...p, periods: n, check_out_date: checkoutFor(p.check_in_date, p.rate_type, n) }))
  }

  async function lookup() {
    if (editing || renewOf) return
    const params = { phone: f.phone.trim(), plate: f.license_plate.trim(), dl: f.dl_number.trim() }
    if (!params.phone && !params.plate && !params.dl) return
    try {
      const { data } = await api.get('/guests/check/', { params })
      const dnr = data.find((g) => g.do_not_rent)
      if (dnr && !dnrAck) setDnrHit(dnr)
      const other = data[0]
      if (other && other.id !== f.guest_id) setMatch(other)
    } catch { /* lookup is a convenience only */ }
  }

  function useMatch() {
    const g = match
    setF((p) => ({
      ...p, guest_id: g.id, ...nameParts(g), address: g.address, city: g.city, state: g.state,
      zip_code: g.zip_code, phone: g.phone, car: g.car, license_plate: g.license_plate, dl_number: g.dl_number || '', do_not_rent: g.do_not_rent,
    }))
    setMatch(null)
  }

  // ---- Do Not Rent check (name / phone / plate against the DNR list)
  const guestName = fullName(f)
  const dnrKey = `${guestName.toLowerCase()}|${f.phone.trim()}|${f.license_plate.trim().toLowerCase()}|${f.dl_number.trim().toLowerCase()}`
  const dnrFresh = dnrResult && dnrResult.key === dnrKey

  async function checkDnr() {
    if (!guestName && !f.phone.trim() && !f.license_plate.trim() && !f.dl_number.trim()) {
      setDnrResult({ key: dnrKey, checked: [], matches: [], empty: true })
      return null
    }
    setDnrBusy(true)
    try {
      const { data } = await api.get('/guests/dnr_check/', { params: { name: guestName, phone: f.phone, plate: f.license_plate, dl: f.dl_number } })
      const res = { key: dnrKey, ...data }
      setDnrResult(res)
      return res
    } catch (e) {
      setErr(errorText(e))
      return null
    } finally {
      setDnrBusy(false)
    }
  }

  async function submit(e, allowOverlap = false, statusOk = false) {
    e?.preventDefault()
    if (!f.room) return setErr('Select a room.')
    if (f.do_not_rent && !dnrAck) {
      setDnrHit({ name: guestName, phone: f.phone, license_plate: f.license_plate, dl_number: f.dl_number, self: true })
      return
    }
    // always check the DNR list before saving a new check-in
    if (!editing && !dnrAck) {
      const res = dnrFresh ? dnrResult : await checkDnr()
      if (res?.matches?.length) {
        setDnrHit({ ...res.matches[0], matches: res.matches })
        return
      }
    }
    setBusy(true)
    setErr('')
    const payload = {
      photo_ids: editing ? [] : [dl.DL_FRONT?.id, dl.DL_BACK?.id].filter(Boolean),
      reuse_dl: !editing && Boolean(f.guest_id),
      ...f, cash: f.cash || 0, credit: f.credit || 0, check: f.check || 0, rate: f.rate || 0,
      weekend_rate: f.rate_type === 'DAILY' ? num(f.weekend_rate).toFixed(2) : '0.00',
      extra_guests: extras.map((g) => ({ id: g.id, name: g.name, dl_number: g.dl_number,
        photo_ids: [g.dl.DL_FRONT?.id, g.dl.DL_BACK?.id].filter(Boolean) })),
      adjustment: num(f.adjustment).toFixed(2), allow_overlap: allowOverlap, room_status_ok: statusOk,
      pets: num(f.pets), extra_persons: extraPersons,
      renew_from: renewOf ? renewOf.id : null, carry_balance: Boolean(renewOf && carry && oldOwed > 0),
      pet_fee: petFee.toFixed(2), extra_person_fee: extraFee.toFixed(2), card_fee: cardFee.toFixed(2), late_fee: lateFee.toFixed(2), early_checkin_fee: earlyFee.toFixed(2),
    }
    try {
      const { data } = editing
        ? await api.put(`/stays/${id}/`, payload)
        : await api.post('/stays/', payload)
      navigate(`/stays/${data.id}`)
    } catch (e2) {
      setBusy(false)
      // room not ready (dirty / cleaning / out of order): ask, then save with the clerk's name on record
      const notReady = e2.response?.data?.room_status
      if (notReady) {
        const code = [].concat(e2.response.data.room_status_code || [])[0]
        const ok = await confirmBox({
          title: code === 'OUT_OF_ORDER' ? 'Room is out of order' : 'Room is not ready',
          message: `${[].concat(notReady)[0]}\nYour name is recorded if you rent it anyway.`,
          tone: code === 'OUT_OF_ORDER' ? 'danger' : 'primary', confirmText: 'Rent anyway',
        })
        if (ok) submit(null, allowOverlap, true)
        return
      }
      const overlapMsg = e2.response?.data?.overlap
      if (overlapMsg) {
        setOverlap(Array.isArray(overlapMsg) ? overlapMsg[0] : overlapMsg)
        return
      }
      setErr(errorText(e2))
      window.scrollTo({ top: 0, behavior: 'smooth' })
    }
  }

  return (
    <>
      <PageHead
        title={editing ? 'Edit Guest' : renewOf ? 'Check in again' : 'New Check-in'}
        sub={editing ? null : renewOf ? 'New entry for a guest staying on' : 'Guest onboarding'}
      />
      {renewOf && (
        <div className="alert alert-info renew-banner">
          Continuing <strong>{renewOf.guest.name}</strong>, Room {renewOf.room_number}
          {' '}({fmtDate(renewOf.check_in_date)} → {fmtDate(renewOf.check_out_date)}).
          {' '}The previous stay will be <strong>checked out</strong> when you save this check-in.
          {oldOwed > 0 && (
            <div className="carry-row">
              <span>Previous stay still owes <strong className="owed">{money(oldOwed)}</strong>. Add it to this check-in?</span>
              <div className="seg seg-sm">
                <button type="button" className={carry ? 'on' : ''} onClick={() => setCarry(true)}>Yes, add {money(oldOwed)}</button>
                <button type="button" className={!carry ? 'on danger' : ''} onClick={() => setCarry(false)}>No</button>
              </div>
              <span className="tiny muted">{carry ? 'The old stay is closed at $0.00 and the new total includes it.' : 'It stays owed on the old stay (Balance Payments).'}</span>
            </div>
          )}
        </div>
      )}
      <Alert>{err}</Alert>
      {match && (
        <div className="alert alert-info">
          Returning guest found: <strong>{match.name}</strong> ({match.dl_number ? `DL ${match.dl_number}` : match.phone || match.license_plate}),
          {' '}{match.stay_count} previous stay(s){match.last_stay ? `, last on ${fmtDate(match.last_stay)}` : ''}.
          <span className="alert-actions">
            <button type="button" className="btn btn-sm btn-primary" onClick={useMatch}>Use details</button>
            <button type="button" className="btn btn-sm" onClick={() => setMatch(null)}>Ignore</button>
          </span>
        </div>
      )}

      <form onSubmit={submit} className="checkin">
        <section className="card">
          <h2>Stay</h2>
          <div className="form-grid cols-4">
            <div className="field span-2">
              <span className="field-label">Room number</span>
              <RoomPicker rooms={board} value={f.room} onChange={pickRoom} currentRoomId={originalRoom} rateType={f.rate_type} />
            </div>
            <div className="field span-2">
              <span className="field-label">Rent by</span>
              <div className="seg">
                {RATE_TYPES.map((t) => (
                  <button type="button" key={t.key} className={f.rate_type === t.key ? 'on' : ''} onClick={() => setRateType(t.key)}>
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
            <label>No. of guests
              <input type="number" min="1" value={f.num_guests} onChange={set('num_guests')} required />
            </label>
            <label>{rt.count}
              <input type="number" min="1" value={periods} onChange={setCount} />
            </label>
            <label>Check-in date
              <input type="date" value={f.check_in_date} onChange={setCheckIn} required />
            </label>
            <label>Check-in time
              <input type="time" value={f.check_in_time} onChange={set('check_in_time')} required />
            </label>
            <label>Checkout date
              <input type="date" value={f.check_out_date} min={f.check_in_date} onChange={setCheckOut} required />
            </label>
            <label>Checkout time
              <input type="time" value={f.check_out_time} onChange={set('check_out_time')} required />
            </label>
          </div>
        </section>

        <section className="card">
          <div className="section-head">
            <h2>Guest</h2>
            <button type="button" className="btn btn-sm btn-dnr" onClick={checkDnr} disabled={dnrBusy}>
              {dnrBusy ? 'Checking…' : '⛔ Check DNR list'}
            </button>
          </div>
          {dnrResult && (
            dnrResult.empty ? (
              <div className="alert alert-info">Enter a name, phone, plate or DL number first, then check the DNR list.</div>
            ) : dnrResult.matches.length ? (
              <div className="alert alert-error dnr-result">
                <strong>On the DNR list:</strong>
                {dnrResult.matches.map((g) => (
                  <div key={g.id} className="dnr-hit">
                    <strong>{g.name}</strong>
                    {g.phone && ` · ${g.phone}`}{g.license_plate && ` · ${g.license_plate}`}{g.dl_number && ` · DL ${g.dl_number}`}
                    {g.dnr_reason && <> · <em>{g.dnr_reason}</em></>}
                    <span className="tiny"> (matched on {g.matched_on.join(', ')})</span>
                  </div>
                ))}
                {!dnrFresh && <div className="tiny">Details changed since this check. Check again.</div>}
              </div>
            ) : (
              <div className={`alert ${dnrFresh ? 'alert-success' : 'alert-info'}`}>
                {dnrFresh
                  ? <>✓ Not on the DNR list (checked {dnrResult.checked.join(', ')}).</>
                  : <>Details changed since the last DNR check. Check again.</>}
              </div>
            )
          )}
          <div className="form-grid cols-4">
            <label><span>First name <span className="req">*</span></span>
              <input value={f.first_name} onChange={set('first_name')} required autoComplete="off" />
            </label>
            <label>Middle name
              <input value={f.middle_name} onChange={set('middle_name')} autoComplete="off" />
            </label>
            <label><span>Last name <span className="req">*</span></span>
              <input value={f.last_name} onChange={set('last_name')} required autoComplete="off" />
            </label>
            <label>Do not rent
              <div className="seg">
                <button type="button" className={!f.do_not_rent ? 'on' : ''} onClick={() => set('do_not_rent')(false)}>No</button>
                <button type="button" className={f.do_not_rent ? 'on danger' : ''} onClick={() => { set('do_not_rent')(true); setDnrAck(false) }}>Yes</button>
              </div>
            </label>
            <label>Phone number
              <input value={f.phone} onChange={set('phone')} onBlur={lookup} inputMode="tel" />
            </label>
            <label>DL number
              <input value={f.dl_number} onChange={set('dl_number')} onBlur={lookup} placeholder="Driving licence" autoComplete="off" />
            </label>
            <label>License plate number
              <input value={f.license_plate} onChange={set('license_plate')} onBlur={lookup} />
            </label>
            <label>Car
              <input value={f.car} onChange={set('car')} placeholder="Make / model / color" />
            </label>
            <label className="span-4">Address
              <input value={f.address} onChange={set('address')} />
            </label>
            <label className="span-2">City
              <input value={f.city} onChange={set('city')} />
            </label>
            <label>State
              <input value={f.state} onChange={set('state')} maxLength={50} />
            </label>
            <label>Zip
              <input value={f.zip_code} onChange={set('zip_code')} />
            </label>
            <div className="span-4">
              <PhotoUploader mode="DL" value={dl} onAdd={addDl} onRemove={removeDl}
                stay={editing ? id : undefined} reused={editing ? undefined : reused}
                title={`DL photos${reused.DL_FRONT || reused.DL_BACK ? ' · last DL on file is used unless you take a new one' : ''}`} />
            </div>
            <div className="span-4 extra-guests">
              <div className="extra-head">
                <span className="subhead">Extra guests {extras.length > 0 && `(${extras.length})`}</span>
                <button type="button" className="btn btn-sm" onClick={addExtra}>+ Add extra guest</button>
              </div>
              {extras.map((g, i) => (
                <div key={g.key} className="extra-row">
                  <div className="extra-fields">
                    <span className="extra-no">{i + 1}</span>
                    <label>Name <span className="req">*</span>
                      <input value={g.name} onChange={(e) => setExtra(g.key, { name: e.target.value })} placeholder="Full name" />
                    </label>
                    <label>DL number
                      <input value={g.dl_number} onChange={(e) => setExtra(g.key, { dl_number: e.target.value })} placeholder="Driving licence" />
                    </label>
                    <button type="button" className="btn btn-sm btn-danger-outline" onClick={() => setExtras((x) => x.filter((y) => y.key !== g.key))}>Remove</button>
                  </div>
                  <PhotoUploader mode="DL" value={g.dl} title={`DL photos · ${g.name || `extra guest ${i + 1}`}`}
                    onAdd={(ph) => setExtras((x) => x.map((y) => (y.key === g.key ? { ...y, dl: { ...y.dl, [ph.kind]: ph } } : y)))}
                    onRemove={(ph) => { api.delete(`/photos/${ph.id}/`).catch(() => {}); setExtras((x) => x.map((y) => (y.key === g.key ? { ...y, dl: { ...y.dl, [ph.kind]: null } } : y))) }} />
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="card">
          <h2>Payment</h2>
          <div className="form-grid cols-4">
            <label>Rate per {rt.unit}
              <input type="number" step="0.01" min="0" value={f.rate} onChange={set('rate')} required />
            </label>
            {f.rate_type === 'DAILY' && (
              <label>Weekend rate (Fri, Sat)
                <input type="number" step="0.01" min="0" value={f.weekend_rate ?? ''} onChange={set('weekend_rate')} placeholder="Same as daily" />
                <span className="hint">Friday and Saturday nights · set per room type by admin</span>
              </label>
            )}
            <div className="readout">
              <span>Room charge ({periodText(periods, f.rate_type)}{f.rate_type !== 'DAILY' ? `, ${days} nights` : ''})</span>
              <strong>{money(roomCharge)}</strong>
              {wkNights > 0 && (
                <span className="tiny muted">{periods - wkNights} × {money(f.rate)} + {wkNights} weekend × {money(f.weekend_rate)}</span>
              )}
            </div>
            <div className={`readout ${f.rate_type === 'DAILY' ? '' : 'span-2'} total-readout`}>
              <span>Total</span>
              <strong>{money(total)}</strong>
              <span className="tiny muted">
                Room {money(roomCharge)}
                {charges > 0 && ` + charges ${money(charges)}`}
                {num(f.adjustment) !== 0 && ` ${num(f.adjustment) > 0 ? '+' : '−'} ${money(Math.abs(num(f.adjustment)))} adj.`}
                {carried > 0 && ` + previous balance ${money(carried)}`}
              </span>
            </div>

            <div className="subhead span-4">Extra charges</div>
            <label>Pets
              <input type="number" min="0" value={f.pets} onChange={set('pets')} />
              <span className="hint">{money(fees?.pet_fee)} per pet</span>
            </label>
            <label>Pet fee
              <span className="fee-input">
                <input type="number" step="0.01" min="0" value={feeValue('pet_fee', petFee)} onChange={setFee('pet_fee')} />
                {f.pet_fee != null && !editing && <button type="button" className="fee-reset" title="Back to auto" onClick={() => resetFee('pet_fee')}>↺</button>}
              </span>
            </label>
            <label>Extra persons
              <span className="fee-input">
                <input type="number" min="0" value={extraPersons} onChange={(e) => setF((p) => ({ ...p, extra_persons: Math.max(num(e.target.value), 0) }))} />
                {f.extra_persons != null && !editing && <button type="button" className="fee-reset" title="Back to auto" onClick={() => resetFee('extra_persons')}>↺</button>}
              </span>
              <span className="hint">Guests above {included} are extra</span>
            </label>
            <label>Extra person fee
              <span className="fee-input">
                <input type="number" step="0.01" min="0" value={feeValue('extra_person_fee', extraFee)} onChange={setFee('extra_person_fee')} />
                {f.extra_person_fee != null && !editing && <button type="button" className="fee-reset" title="Back to auto" onClick={() => resetFee('extra_person_fee')}>↺</button>}
              </span>
              <span className="hint">{money(fees?.extra_person_fee)} × {extraPersons} × {days} night{days > 1 ? 's' : ''}</span>
            </label>
            <label>Card fee
              <span className="fee-input">
                <input type="number" step="0.01" min="0" value={feeValue('card_fee', cardFee)} onChange={setFee('card_fee')} />
                {f.card_fee != null && !editing && <button type="button" className="fee-reset" title="Back to auto" onClick={() => resetFee('card_fee')}>↺</button>}
              </span>
              <span className="hint">{editing ? 'Fee on card payments' : `${cardPct}% of the card amount`}</span>
            </label>
            <label>Late fee
              <span className="fee-input">
                <input type="number" step="0.01" min="0" value={f.late_fee} onChange={setFee('late_fee')} />
                {lateFee > 0 && <button type="button" className="fee-reset" title="Remove late fee" onClick={() => setF((p) => ({ ...p, late_fee: 0 }))}>✕</button>}
              </span>
              {num(fees?.late_fee) > 0 && lateFee !== num(fees?.late_fee)
                ? <button type="button" className="link-btn" onClick={() => setF((p) => ({ ...p, late_fee: num(fees.late_fee) }))}>Apply late fee {money(fees.late_fee)}</button>
                : <span className="hint">{num(fees?.late_fee) > 0 ? 'Late checkout / late arrival' : 'Set a default in Charges & Fees'}</span>}
            </label>
            <label>Early check-in fee
              <span className="fee-input">
                <input type="number" step="0.01" min="0" value={f.early_checkin_fee} onChange={setFee('early_checkin_fee')} />
                {earlyFee > 0 && <button type="button" className="fee-reset" title="Remove early check-in fee" onClick={() => setF((p) => ({ ...p, early_checkin_fee: 0 }))}>✕</button>}
              </span>
              {num(fees?.early_checkin_fee) > 0 && earlyFee !== num(fees?.early_checkin_fee)
                ? <button type="button" className="link-btn" onClick={() => setF((p) => ({ ...p, early_checkin_fee: num(fees.early_checkin_fee) }))}>Apply early check-in fee {money(fees.early_checkin_fee)}</button>
                : <span className="hint">{num(fees?.early_checkin_fee) > 0 ? 'Guest arrives before check-in time' : 'Set a default in Charges & Fees'}</span>}
            </label>
            <div className="readout">
              <span>Total extra charges</span>
              <strong>{money(charges)}</strong>
            </div>

            <div className="subhead span-4">Payment collected</div>
            {!editing ? (
              <>
                <label>Cash
                  <input type="number" step="0.01" min="0" value={f.cash} onChange={set('cash')} placeholder="0.00" />
                  <button type="button" className="link-btn" onClick={cashForBalance}>Put balance in cash</button>
                </label>
                <label>Credit / card
                  <input type="number" step="0.01" min="0" value={f.credit} onChange={set('credit')} placeholder="0.00" />
                  <button type="button" className="link-btn" onClick={cardForBalance}>Put balance on card</button>
                </label>
                <label>Check
                  <input type="number" step="0.01" min="0" value={f.check} onChange={set('check')} placeholder="0.00" />
                  <button type="button" className="link-btn" onClick={checkForBalance}>Put balance in check</button>
                </label>
              </>
            ) : (
              <div className="readout span-2">
                <span>Paid so far</span>
                <strong>{money(paidBefore)} <span className="tiny muted">(add payments on the guest page)</span></strong>
              </div>
            )}
            {editing && stayNow?.payments?.length > 0 && (
              <div className="span-4 edit-payments">
                <span className="field-label">Payments taken · fix a wrong amount or method here</span>
                <PaymentList stay={stayNow} onChanged={(d) => { setStayNow(d); setPaidBefore(num(d.amount_paid)) }} />
              </div>
            )}
            <label>Balance
              <input
                type="number" step="0.01"
                className={balance > 0 ? 'input-owed' : ''}
                value={balanceText ?? balance.toFixed(2)}
                onFocus={(e) => { setBalanceText(balance.toFixed(2)); e.target.select() }}
                onChange={editBalance}
                onBlur={() => setBalanceText(null)}
              />
            </label>
            {num(f.adjustment) !== 0 && (
              <div className="adj-note span-4">
                Balance edited: total includes {num(f.adjustment) > 0 ? 'an extra charge of' : 'a discount of'}{' '}
                <strong>{money(Math.abs(num(f.adjustment)))}</strong> ({money(roomCharge + charges)} room and charges{carried > 0 ? ` + ${money(carried)} previous balance` : ''} {num(f.adjustment) > 0 ? '+' : '−'} {money(Math.abs(num(f.adjustment)))} = {money(total)}).
                <button type="button" className="btn btn-sm ml" onClick={() => setF((p) => ({ ...p, adjustment: 0 }))}>Reset</button>
              </div>
            )}
            <div className={editing ? 'readout' : 'readout span-4 clerk-line'}>
              <span>Clerk</span>
              <strong>{user.full_name}</strong>
            </div>
            <label className="span-4">Comments
              <textarea rows={2} value={f.comments} onChange={set('comments')} />
            </label>
          </div>
        </section>

        <div className="form-actions sticky-actions">
          <button type="button" className="btn" onClick={() => navigate(-1)}>Cancel</button>
          <button className="btn btn-primary btn-lg" disabled={busy}>
            {busy ? 'Saving…' : editing ? 'Save changes' : renewOf ? 'Check out old stay & check in' : 'Check in guest'}
          </button>
        </div>
      </form>

      {overlap && (
        <Modal title="Room already rented" onClose={() => setOverlap(null)}>
          <div className="alert alert-info">{overlap}</div>
          <p>Rent this room to <strong>{guestName || 'this guest'}</strong> as well?</p>
          <div className="form-actions">
            <button className="btn" onClick={() => setOverlap(null)}>Pick another room</button>
            <button className="btn btn-primary" onClick={() => { setOverlap(null); submit(null, true) }}>Yes, rent again</button>
          </div>
        </Modal>
      )}

      {dnrHit && (
        <Modal title="⚠ Do Not Rent" onClose={() => setDnrHit(null)}>
          <div className="alert alert-error">
            <strong>{dnrHit.name}</strong> is flagged <strong>Do Not Rent</strong>
            {dnrHit.self ? ' on this form.' : ` (phone ${dnrHit.phone || 'n/a'}, plate ${dnrHit.license_plate || 'n/a'}${dnrHit.dl_number ? `, DL ${dnrHit.dl_number}` : ''}).`}
            {dnrHit.dnr_reason && <div>Reason: <strong>{dnrHit.dnr_reason}</strong></div>}
            {dnrHit.matched_on && <div className="tiny">Matched on {dnrHit.matched_on.join(', ')}</div>}
            {dnrHit.matches?.length > 1 && <div className="tiny">{dnrHit.matches.length - 1} more match(es) on the DNR list.</div>}
          </div>
          <p>Do you still want to rent to this guest?</p>
          <div className="form-actions">
            <button className="btn" onClick={() => { setDnrHit(null); navigate('/') }}>Cancel check-in</button>
            <button className="btn btn-danger" onClick={() => { setDnrAck(true); setDnrHit(null) }}>Proceed anyway</button>
          </div>
        </Modal>
      )}
    </>
  )
}
