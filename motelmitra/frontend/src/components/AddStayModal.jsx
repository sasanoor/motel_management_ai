import { useState } from 'react'
import api, { errorText } from '../api'
import { addDays, addMonths, daysBetween, fmtDate, money, num } from '../utils'
import usePayment from '../usePayment'
import PaymentCollected from './PaymentCollected'
import { Alert, Modal } from './ui'

const UNIT = { DAILY: 'night', WEEKLY: 'week', MONTHLY: 'month' }

/**
 * Add stay: the guest stays longer (usually paying in advance). Same entry and rate,
 * new checkout date, payment taken now (counted on today's business day).
 */
export default function AddStayModal({ stay, onClose, onSaved }) {
  const [n, setN] = useState('1')
  const [notes, setNotes] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const r2 = (x) => Math.round(x * 100) / 100
  const type = stay.rate_type || 'DAILY'
  const unit = UNIT[type]
  const count = Math.max(Math.floor(num(n)), 0)
  const newOut = type === 'WEEKLY' ? addDays(stay.check_out_date, 7 * count)
    : type === 'MONTHLY' ? addMonths(stay.check_out_date, count) : addDays(stay.check_out_date, count)
  const addedNights = daysBetween(stay.check_out_date, newOut)
  const roomAdd = r2(num(stay.rate) * count)
  const extraAdd = num(stay.extra_person_fee) && stay.num_days
    ? r2((num(stay.extra_person_fee) / stay.num_days) * addedNights) : 0
  // owed after adding the nights, before today's payment (same payment box as check-in)
  const p = usePayment(r2(num(stay.total_amount) + roomAdd + extraAdd - num(stay.amount_paid)))
  const newTotal = r2(num(stay.total_amount) + roomAdd + extraAdd + p.cardFee + p.adj)

  async function save(e, allowOverlap = false) {
    e?.preventDefault()
    setBusy(true); setErr('')
    try {
      const { data } = await api.post(`/stays/${stay.id}/extend/`, {
        periods: count, ...p.body(), notes, allow_overlap: allowOverlap,
      })
      onSaved(data)
    } catch (e2) {
      const overlap = e2.response?.data?.overlap
      if (overlap && !allowOverlap && window.confirm(overlap)) return save(null, true)
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
          <label>Add {unit}s
            <input type="number" min="1" step="1" value={n} onChange={(e) => setN(e.target.value)} autoFocus required />
            <span className="hint">{money(stay.rate)} per {unit}, same rate as the stay</span>
          </label>
          <div className="readout">
            <span>New checkout</span>
            <strong>{count ? fmtDate(newOut) : '—'}</strong>
            {count > 0 && <span className="tiny muted">{addedNights} more night{addedNights > 1 ? 's' : ''} · {stay.num_days + addedNights} in total</span>}
          </div>
          <div className="readout">
            <span>Room charge added</span>
            <strong>{money(roomAdd + extraAdd)}</strong>
            <span className="tiny muted">{count} × {money(stay.rate)}{extraAdd > 0 && ` + extra person ${money(extraAdd)}`}</span>
          </div>
          <div className="readout total-readout">
            <span>New total</span>
            <strong>{money(newTotal)}</strong>
          </div>
        </div>
        <PaymentCollected p={p} totalNote={<><span>Owed after adding</span><strong>{money(r2(num(stay.total_amount) + roomAdd + extraAdd - num(stay.amount_paid)))}</strong></>} />
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
