import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import api, { errorText } from '../api'
import { useAuth } from '../auth'
import { Alert, Modal, PageHead } from '../components/ui'
import { addDays, daysBetween, fmtDate, money, nowTime, num, todayISO } from '../utils'

const blank = (room = '', date = todayISO()) => ({
  room,
  check_in_date: date,
  check_in_time: nowTime(),
  check_out_date: addDays(date, 1),
  check_out_time: '11:00',
  num_guests: 1,
  rate: '',
  name: '', address: '', city: '', state: '', zip_code: '',
  phone: '', car: '', license_plate: '',
  do_not_rent: false,
  cash: '', credit: '',
  comments: '',
  adjustment: 0,
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
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [originalRoom, setOriginalRoom] = useState(null)
  const [paidBefore, setPaidBefore] = useState(0)      // edit mode: payments already taken
  const [balanceText, setBalanceText] = useState(null) // text while the clerk types a balance

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
      setF({
        ...blank(),
        room: s.room,
        check_in_date: s.check_in_date, check_in_time: s.check_in_time.slice(0, 5),
        check_out_date: s.check_out_date, check_out_time: s.check_out_time.slice(0, 5),
        num_guests: s.num_guests, rate: s.rate, comments: s.comments, adjustment: num(s.adjustment),
        name: s.guest.name, address: s.guest.address, city: s.guest.city, state: s.guest.state,
        zip_code: s.guest.zip_code, phone: s.guest.phone, car: s.guest.car,
        license_plate: s.guest.license_plate, do_not_rent: s.guest.do_not_rent, guest_id: s.guest.id,
      })
      setDnrAck(true)
    }).catch((e) => setErr(errorText(e)))
  }, [editing, id])

  // rooms + their status for the check-in date
  useEffect(() => {
    api.get('/rooms/board/', { params: { date: f.check_in_date } }).then((r) => {
      setBoard(r.data)
      // pre-fill the rate when the room came from the Room sheet
      setF((p) => {
        if (!p.room || p.rate) return p
        const room = r.data.find((x) => String(x.id) === String(p.room))
        return room ? { ...p, rate: room.default_rate } : p
      })
    }).catch(() => {})
  }, [f.check_in_date])

  const days = Math.max(daysBetween(f.check_in_date, f.check_out_date), 1)
  const roomCharge = num(f.rate) * days
  const total = roomCharge + num(f.adjustment)
  const paidNow = editing ? paidBefore : num(f.cash) + num(f.credit)
  const balance = total - paidNow

  // Clerk types a balance: keep rate and payments, store the difference as an adjustment.
  function editBalance(e) {
    const text = e.target.value
    setBalanceText(text)
    if (text === '' || isNaN(Number(text))) return
    const adj = Number(text) - (roomCharge - paidNow)
    setF((p) => ({ ...p, adjustment: Math.round(adj * 100) / 100 }))
  }

  const roomsByType = useMemo(() => {
    const g = {}
    board.forEach((r) => { (g[r.room_type] ||= []).push(r) })
    return g
  }, [board])

  function pickRoom(e) {
    const roomId = e.target.value
    const r = board.find((x) => String(x.id) === roomId)
    setF((p) => ({ ...p, room: roomId, rate: !editing || !p.rate ? (r?.default_rate ?? p.rate) : p.rate }))
  }

  function setDays(e) {
    const n = Math.max(parseInt(e.target.value || '1', 10), 1)
    setF((p) => ({ ...p, check_out_date: addDays(p.check_in_date, n) }))
  }

  async function lookup() {
    if (editing) return
    const params = { phone: f.phone.trim(), plate: f.license_plate.trim() }
    if (!params.phone && !params.plate) return
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
      ...p, guest_id: g.id, name: g.name, address: g.address, city: g.city, state: g.state,
      zip_code: g.zip_code, phone: g.phone, car: g.car, license_plate: g.license_plate, do_not_rent: g.do_not_rent,
    }))
    setMatch(null)
  }

  async function submit(e, allowOverlap = false) {
    e?.preventDefault()
    if (!f.room) return setErr('Select a room.')
    if (f.do_not_rent && !dnrAck) {
      setDnrHit({ name: f.name, phone: f.phone, license_plate: f.license_plate, self: true })
      return
    }
    setBusy(true)
    setErr('')
    const payload = {
      ...f, cash: f.cash || 0, credit: f.credit || 0, rate: f.rate || 0,
      adjustment: num(f.adjustment).toFixed(2), allow_overlap: allowOverlap,
    }
    try {
      const { data } = editing
        ? await api.put(`/stays/${id}/`, payload)
        : await api.post('/stays/', payload)
      navigate(`/stays/${data.id}`)
    } catch (e2) {
      setBusy(false)
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
      <PageHead title={editing ? 'Edit Guest' : 'New Check-in'} sub={editing ? null : 'Guest onboarding'} />
      <Alert>{err}</Alert>
      {match && (
        <div className="alert alert-info">
          Returning guest found: <strong>{match.name}</strong> ({match.phone || match.license_plate}),
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
            <label className="span-2">Room number
              <select value={f.room} onChange={pickRoom} required>
                <option value="">Select room…</option>
                {Object.entries(roomsByType).map(([type, rooms]) => (
                  <optgroup key={type} label={type}>
                    {rooms.map((r) => {
                      const busyRoom = r.occupied && r.id !== originalRoom
                      return (
                        <option key={r.id} value={r.id}>
                          {r.number} · {type} · {money(r.default_rate)}
                          {busyRoom ? ` (occupied: ${r.guest_name} till ${fmtDate(r.check_out_date)})` : ''}
                        </option>
                      )
                    })}
                  </optgroup>
                ))}
              </select>
            </label>
            <label>No. of guests
              <input type="number" min="1" value={f.num_guests} onChange={set('num_guests')} required />
            </label>
            <label>No. of days
              <input type="number" min="1" value={days} onChange={setDays} />
            </label>
            <label>Check-in date
              <input type="date" value={f.check_in_date} onChange={set('check_in_date')} required />
            </label>
            <label>Check-in time
              <input type="time" value={f.check_in_time} onChange={set('check_in_time')} required />
            </label>
            <label>Checkout date
              <input type="date" value={f.check_out_date} min={f.check_in_date} onChange={set('check_out_date')} required />
            </label>
            <label>Checkout time
              <input type="time" value={f.check_out_time} onChange={set('check_out_time')} required />
            </label>
          </div>
        </section>

        <section className="card">
          <h2>Guest</h2>
          <div className="form-grid cols-4">
            <label className="span-2">Name
              <input value={f.name} onChange={set('name')} required />
            </label>
            <label>Phone number
              <input value={f.phone} onChange={set('phone')} onBlur={lookup} inputMode="tel" />
            </label>
            <label>Do not rent
              <div className="seg">
                <button type="button" className={!f.do_not_rent ? 'on' : ''} onClick={() => set('do_not_rent')(false)}>No</button>
                <button type="button" className={f.do_not_rent ? 'on danger' : ''} onClick={() => { set('do_not_rent')(true); setDnrAck(false) }}>Yes</button>
              </div>
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
            <label className="span-2">Car
              <input value={f.car} onChange={set('car')} placeholder="Make / model / color" />
            </label>
            <label className="span-2">License plate number
              <input value={f.license_plate} onChange={set('license_plate')} onBlur={lookup} />
            </label>
          </div>
        </section>

        <section className="card">
          <h2>Payment</h2>
          <div className="form-grid cols-4">
            <label>Rate / night
              <input type="number" step="0.01" min="0" value={f.rate} onChange={set('rate')} required />
            </label>
            <div className="readout">
              <span>Total ({days} night{days > 1 ? 's' : ''})</span>
              <strong>{money(total)}</strong>
            </div>
            {!editing ? (
              <>
                <label>Cash
                  <input type="number" step="0.01" min="0" value={f.cash} onChange={set('cash')} placeholder="0.00" />
                </label>
                <label>Credit
                  <input type="number" step="0.01" min="0" value={f.credit} onChange={set('credit')} placeholder="0.00" />
                </label>
              </>
            ) : (
              <div className="readout span-2">
                <span>Paid so far</span>
                <strong>{money(paidBefore)} <span className="tiny muted">(add payments on the guest page)</span></strong>
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
                <strong>{money(Math.abs(num(f.adjustment)))}</strong> ({money(roomCharge)} room charge {num(f.adjustment) > 0 ? '+' : '−'} {money(Math.abs(num(f.adjustment)))} = {money(total)}).
                <button type="button" className="btn btn-sm ml" onClick={() => setF((p) => ({ ...p, adjustment: 0 }))}>Reset</button>
              </div>
            )}
            <div className="readout">
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
            {busy ? 'Saving…' : editing ? 'Save changes' : 'Check in guest'}
          </button>
        </div>
      </form>

      {overlap && (
        <Modal title="Room already rented" onClose={() => setOverlap(null)}>
          <div className="alert alert-info">{overlap}</div>
          <p>Rent this room to <strong>{f.name || 'this guest'}</strong> as well?</p>
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
            {dnrHit.self ? ' on this form.' : ` (phone ${dnrHit.phone || 'n/a'}, plate ${dnrHit.license_plate || 'n/a'}).`}
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
