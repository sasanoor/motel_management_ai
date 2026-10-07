import { useEffect, useState } from 'react'
import api, { errorText } from '../api'
import { addDays, addMonths, daysBetween, fmtDate, money, num, RATE_TYPES } from '../utils'
import usePayment from '../usePayment'
import PaymentCollected from './PaymentCollected'
import { Alert, Modal } from './ui'
import { confirmBox } from '../confirm'

const UNIT = { DAILY: 'night', WEEKLY: 'week', MONTHLY: 'month' }

/**
 * Add stay: the guest stays longer (usually paying in advance). Same entry, new checkout date,
 * payment taken now (counted on today's business day). Rent by Daily / Weekly / Monthly like
 * check-in: the stay's own type and rate by default, or another type at the room type's rate.
 */
export default function AddStayModal({ stay, onClose, onSaved }) {
  const [n, setN] = useState('1')
  const [notes, setNotes] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const r2 = (x) => Math.round(x * 100) / 100
  const own = stay.rate_type || 'DAILY'
  const [type, setType] = useState(own)
  const defaultRate = (t) => (t === own ? num(stay.rate) : num(stay.room_rates?.[t])).toFixed(2)
  const [rate, setRate] = useState(defaultRate(own))
  const pickType = (t) => { setType(t); setRate(defaultRate(t)) }
  const unit = UNIT[type]
  const count = Math.max(Math.floor(num(n)), 0)
  const newOut = type === 'WEEKLY' ? addDays(stay.check_out_date, 7 * count)
    : type === 'MONTHLY' ? addMonths(stay.check_out_date, count) : addDays(stay.check_out_date, count)
  const addedNights = daysBetween(stay.check_out_date, newOut)
  const roomAdd = r2(num(rate) * count)
  // Extra charges for the added stay, same boxes as check-in. Extra person fee is automatic
  // (same nightly amount as the stay) until the clerk types one.
  const [fees, setFees] = useState(null)
  useEffect(() => { api.get('/settings/').then((r) => setFees(r.data)).catch(() => {}) }, [])
  const [pets, setPets] = useState(String(stay.pets || 0))
  const [petFee, setPetFee] = useState('0')
  const [xpFee, setXpFee] = useState(null)        // null = automatic
  const [lateFee, setLateFee] = useState('0')
  const [earlyFee, setEarlyFee] = useState('0')
  const autoXp = num(stay.extra_person_fee) && stay.num_days
    ? r2((num(stay.extra_person_fee) / stay.num_days) * addedNights) : 0
  const extraAdd = xpFee == null ? autoXp : num(xpFee)
  const extras = r2(num(petFee) + extraAdd + num(lateFee) + num(earlyFee))
  // owed after adding the nights and charges, before today's payment (same payment box as check-in)
  const p = usePayment(r2(num(stay.total_amount) + roomAdd + extras - num(stay.amount_paid)))
  const newTotal = r2(num(stay.total_amount) + roomAdd + extras + p.cardFee + p.adj)

  async function save(e, allowOverlap = false) {
    e?.preventDefault()
    setBusy(true); setErr('')
    try {
      const { data } = await api.post(`/stays/${stay.id}/extend/`, {
        periods: count, rate_type: type, rate, ...p.body(), notes, allow_overlap: allowOverlap,
        pets: num(pets), pet_fee_add: num(petFee).toFixed(2), late_fee_add: num(lateFee).toFixed(2),
        early_checkin_fee_add: num(earlyFee).toFixed(2), extra_person_fee_add: xpFee == null ? '' : num(xpFee).toFixed(2),
      })
      onSaved(data)
    } catch (e2) {
      const overlap = e2.response?.data?.overlap
      if (overlap && !allowOverlap && await confirmBox({ title: 'Room is booked later', message: overlap, tone: 'primary', confirmText: 'Add stay anyway' })) return save(null, true)
      setErr(errorText(e2))
      setBusy(false)
    }
  }

  return (
    <Modal title={`Add stay: ${stay.guest.name}, Room ${stay.room_number}`} onClose={onClose} width={860}>
      <div className="pay-summary">
        <div><span>Checkout now</span><strong>{fmtDate(stay.check_out_date)}</strong></div>
        <div><span>Total</span><strong>{money(stay.total_amount)}</strong></div>
        <div><span>Paid</span><strong>{money(stay.amount_paid)}</strong></div>
        <div><span>Balance</span><strong className={num(stay.balance) > 0 ? 'owed' : ''}>{money(stay.balance)}</strong></div>
      </div>
      <Alert>{err}</Alert>
      <form onSubmit={save}>
        <div className="form-grid cols-4">
          <div className="subhead span-4">Stay</div>
          <div className="field span-2">
            <span className="field-label">Rent by</span>
            <div className="seg">
              {RATE_TYPES.map((t) => (
                <button type="button" key={t.key} className={type === t.key ? 'on' : ''} onClick={() => pickType(t.key)}>{t.label}</button>
              ))}
            </div>
          </div>
          <label>Rate per {unit}
            <input type="number" min="0" step="0.01" value={rate} onChange={(e) => setRate(e.target.value)} required />
            <span className="hint">{type === own && num(rate) === num(stay.rate) ? 'Same rate as the stay' : `Room type ${RATE_TYPES.find((t) => t.key === type).label.toLowerCase()} rate ${money(stay.room_rates?.[type])}`}</span>
          </label>
          <label>Add {unit}s
            <input type="number" min="1" step="1" value={n} onChange={(e) => setN(e.target.value)} autoFocus required />
          </label>
          <div className="readout">
            <span>New checkout</span>
            <strong>{count ? fmtDate(newOut) : '—'}</strong>
            {count > 0 && <span className="tiny muted">{addedNights} more night{addedNights > 1 ? 's' : ''} · {stay.num_days + addedNights} in total</span>}
          </div>
          <div className="readout">
            <span>Room charge added</span>
            <strong>{money(roomAdd)}</strong>
            <span className="tiny muted">{count} × {money(rate)}</span>
          </div>
          <div className="readout total-readout">
            <span>New total</span>
            <strong>{money(newTotal)}</strong>
          </div>
        </div>
        <PaymentCollected p={p} extraTotal={extras}
          totalNote={<><span>Owed after adding</span><strong>{money(p.owedNow)}</strong></>}
          extraFields={<>
            <label>Pets
              <input type="number" min="0" value={pets} onChange={(e) => setPets(e.target.value)} />
              <span className="hint">{money(fees?.pet_fee)} per pet</span>
            </label>
            <label>Pet fee
              <input type="number" min="0" step="0.01" value={petFee} onChange={(e) => setPetFee(e.target.value)} />
              {num(fees?.pet_fee) > 0 && num(pets) > 0 && (
                <button type="button" className="link-btn" onClick={() => setPetFee(r2(num(pets) * num(fees.pet_fee)).toFixed(2))}>
                  Apply {num(pets)} × {money(fees.pet_fee)}
                </button>
              )}
            </label>
            <label>Extra persons
              <input type="number" value={stay.extra_persons || 0} disabled />
              <span className="hint">From the check-in</span>
            </label>
            <label>Extra person fee
              <span className="fee-input">
                <input type="number" min="0" step="0.01" value={xpFee ?? autoXp.toFixed(2)} onChange={(e) => setXpFee(e.target.value)} />
                {xpFee != null && <button type="button" className="fee-reset" title="Back to auto" onClick={() => setXpFee(null)}>↺</button>}
              </span>
              <span className="hint">{autoXp > 0 ? `Same per night as the stay, ${addedNights} more night${addedNights === 1 ? '' : 's'}` : 'No extra persons on this stay'}</span>
            </label>
            <label>Late fee
              <input type="number" min="0" step="0.01" value={lateFee} onChange={(e) => setLateFee(e.target.value)} />
              {num(fees?.late_fee) > 0 && <button type="button" className="link-btn" onClick={() => setLateFee(num(fees.late_fee).toFixed(2))}>Apply late fee {money(fees.late_fee)}</button>}
            </label>
            <label>Early check-in fee
              <input type="number" min="0" step="0.01" value={earlyFee} onChange={(e) => setEarlyFee(e.target.value)} />
              {num(fees?.early_checkin_fee) > 0 && <button type="button" className="link-btn" onClick={() => setEarlyFee(num(fees.early_checkin_fee).toFixed(2))}>Apply early check-in fee {money(fees.early_checkin_fee)}</button>}
            </label>
          </>} />
        <div className="form-grid cols-4">
          <label className="span-4">Notes
            <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
          </label>
        </div>
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || count < 1 || newTotal < 0}>
            {busy ? 'Saving…' : `Add ${count} ${unit}${count === 1 ? '' : 's'}${p.paying > 0 ? ` & take ${money(p.paying)}` : ''}`}
          </button>
        </div>
      </form>
    </Modal>
  )
}
