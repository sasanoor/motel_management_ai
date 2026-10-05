import { useEffect, useState } from 'react'
import api, { errorText } from '../api'
import { addDays, addMonths, daysBetween, fmtDate, money, num } from '../utils'
import { Alert, Modal } from './ui'

const UNIT = { DAILY: 'night', WEEKLY: 'week', MONTHLY: 'month' }

/**
 * Add stay: the guest stays longer (usually paying in advance). Same entry and rate,
 * new checkout date, payment taken now (counted on today's business day).
 */
export default function AddStayModal({ stay, onClose, onSaved }) {
  const [n, setN] = useState('1')
  const [cash, setCash] = useState('')
  const [credit, setCredit] = useState('')
  const [fee, setFee] = useState(null)       // null = auto (% of card amount)
  const [pct, setPct] = useState(0)
  const [notes, setNotes] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => { api.get('/settings/').then((r) => setPct(num(r.data.card_fee_percent))).catch(() => {}) }, [])

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
  const cardFee = fee ?? r2((num(credit) * pct) / 100)
  const newTotal = r2(num(stay.total_amount) + roomAdd + extraAdd + cardFee)
  const owedNow = r2(newTotal - num(stay.amount_paid))          // before today's payment
  const after = r2(owedNow - num(cash) - num(credit))
  const paying = num(cash) + num(credit)

  function payAllCash() { setCredit(''); setFee(null); setCash(Math.max(r2(newTotal - cardFee - num(stay.amount_paid)), 0).toFixed(2)) }
  function balanceOnCard() {
    const due = r2(num(stay.total_amount) + roomAdd + extraAdd - num(stay.amount_paid) - num(cash))
    if (due <= 0) return
    const c = fee == null ? due / (1 - pct / 100) : due + num(fee)
    setCredit(r2(c).toFixed(2))
  }

  async function save(e, allowOverlap = false) {
    e?.preventDefault()
    setBusy(true); setErr('')
    try {
      const { data } = await api.post(`/stays/${stay.id}/extend/`, {
        periods: count, cash: num(cash).toFixed(2), credit: num(credit).toFixed(2),
        card_fee: cardFee.toFixed(2), notes, allow_overlap: allowOverlap,
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
    <Modal title={`Add stay: ${stay.guest.name}, Room ${stay.room_number}`} onClose={onClose} width={620}>
      <div className="pay-summary">
        <div><span>Checkout now</span><strong>{fmtDate(stay.check_out_date)}</strong></div>
        <div><span>Total</span><strong>{money(stay.total_amount)}</strong></div>
        <div><span>Paid</span><strong>{money(stay.amount_paid)}</strong></div>
        <div><span>Balance</span><strong className={num(stay.balance) > 0 ? 'owed' : ''}>{money(stay.balance)}</strong></div>
      </div>
      <Alert>{err}</Alert>
      <form onSubmit={save} className="form-grid cols-2">
        <label>Add {unit}s
          <input type="number" min="1" step="1" value={n} onChange={(e) => setN(e.target.value)} autoFocus required />
          <span className="hint">{money(stay.rate)} per {unit}, same rate as the stay</span>
        </label>
        <div className="readout">
          <span>New checkout</span>
          <strong>{count ? fmtDate(newOut) : '—'}</strong>
          {count > 0 && <span className="tiny muted">{addedNights} more night{addedNights > 1 ? 's' : ''} · {stay.num_days + addedNights} in total</span>}
        </div>
        <div className="readout span-2 add-stay-sum">
          <span>Added</span>
          <strong>{money(roomAdd + extraAdd)}</strong>
          <span className="tiny muted">
            {count} {unit}{count === 1 ? '' : 's'} × {money(stay.rate)}{extraAdd > 0 && ` + extra person ${money(extraAdd)}`} · new total {money(newTotal)}
          </span>
        </div>

        <div className="subhead span-2">Advance payment <button type="button" className="link-btn" onClick={payAllCash}>Pay all in cash</button></div>
        <label>Cash
          <input type="number" step="0.01" min="0" value={cash} onChange={(e) => setCash(e.target.value)} placeholder="0.00" />
        </label>
        <label>Credit / card
          <input type="number" step="0.01" min="0" value={credit} onChange={(e) => setCredit(e.target.value)} placeholder="0.00" />
          <button type="button" className="link-btn" onClick={balanceOnCard}>Put balance on card</button>
        </label>
        <label>Card fee
          <span className="fee-input">
            <input type="number" step="0.01" min="0" value={fee ?? cardFee} onChange={(e) => setFee(e.target.value === '' ? 0 : Number(e.target.value))} />
            {fee != null && <button type="button" className="fee-reset" title="Back to auto" onClick={() => setFee(null)}>↺</button>}
          </span>
          <span className="hint">{pct > 0 ? `${pct}% of the card amount` : 'Card fee % is 0. The admin sets it in Charges & Fees'}</span>
        </label>
        <div className="readout">
          <span>Balance after</span>
          <strong className={after > 0 ? 'owed' : after < 0 ? 'credit-bal' : ''}>{money(after)}</strong>
          {after > 0 && <span className="tiny muted">Stays in Balance Payments</span>}
        </div>
        <label className="span-2">Notes
          <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
        </label>
        <div className="span-2 form-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || count < 1}>
            {busy ? 'Saving…' : `Add ${count} ${unit}${count === 1 ? '' : 's'}${paying > 0 ? ` & take ${money(paying)}` : ''}`}
          </button>
        </div>
      </form>
    </Modal>
  )
}
