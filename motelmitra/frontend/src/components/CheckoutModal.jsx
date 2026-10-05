import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api, { errorText } from '../api'
import { addDays, calendarToday, fmtDate, fmtTime, money, nowTime, num, todayISO } from '../utils'
import { PhotoUploader } from './Photos'
import { Alert, Modal } from './ui'

const METHODS = [
  { key: 'DAILY_RATE', label: 'Charge nights used', help: (q) => `${q.nights_used} night${q.nights_used > 1 ? 's' : ''} × ${money(q.daily_rate)} daily rate` },
  { key: 'PRORATA', label: 'Pro-rata', help: (q) => `${money(q.original_room_charge)} × ${q.nights_used} / ${q.nights_booked} nights`, notDaily: true },
  { key: 'NO_REFUND', label: 'No refund', help: () => 'Guest pays the full booking' },
  { key: 'CUSTOM', label: 'Custom amount', help: () => 'Enter the room charge for the nights used' },
]

/**
 * Check out a guest.
 *  - Before the booked checkout date: early checkout with a refund (or balance still owed).
 *  - After the checkout time: optional late fee.
 *  - Or check out and start a new check-in for the same guest (renewal).
 */
export default function CheckoutModal({ stay, onClose, onDone }) {
  const navigate = useNavigate()
  // later of business day and calendar day: leaving at 7 AM on the checkout date is not early
  const today = [todayISO(), calendarToday()].sort()[1]
  const early = today >= stay.check_in_date && today < stay.check_out_date
  const late = !early && (today > stay.check_out_date || (today === stay.check_out_date && nowTime() > (stay.check_out_time || '').slice(0, 5)))

  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [fees, setFees] = useState(null)
  const [lateOn, setLateOn] = useState(false)
  const [lateAmt, setLateAmt] = useState('')

  // early checkout state
  const [date, setDate] = useState(today)
  const [method, setMethod] = useState('DAILY_RATE')
  const [custom, setCustom] = useState('')
  const [quote, setQuote] = useState(null)
  const [qErr, setQErr] = useState('')
  const [refund, setRefund] = useState(null)       // null = full refund due
  const [refundMethod, setRefundMethod] = useState(num(stay.credit_paid) > num(stay.cash_paid) ? 'CREDIT' : 'CASH') // back the way most was paid
  const [notes, setNotes] = useState('')
  // room condition: damage photos (saved straight to the stay), notes, fee, DNR
  const [damagePhotos, setDamagePhotos] = useState([])
  const [damageNotes, setDamageNotes] = useState('')
  const [damageFee, setDamageFee] = useState('')
  const [addDnr, setAddDnr] = useState(false)
  const damageValue = Math.max(num(damageFee), 0)
  const damageBody = { damage_fee: damageValue.toFixed(2), damage_notes: damageNotes, add_dnr: addDnr }

  useEffect(() => { api.get('/settings/').then((r) => setFees(r.data)).catch(() => {}) }, [])

  useEffect(() => {
    if (!early) return
    if (method === 'CUSTOM' && custom === '') return
    let live = true
    const params = { date, method, ...(method === 'CUSTOM' ? { room_charge: custom } : {}), damage_fee: damageValue || undefined }
    api.get(`/stays/${stay.id}/early_quote/`, { params })
      .then((r) => { if (live) { setQuote(r.data); setQErr('') } })
      .catch((e) => { if (live) { setQuote(null); setQErr(errorText(e)) } })
    return () => { live = false }
  }, [early, stay.id, date, method, custom, damageValue])

  const owes = num(stay.balance) > 0
  const hadLateFee = num(stay.late_fee) > 0
  const defaultLate = num(fees?.late_fee)
  const lateValue = lateAmt === '' ? defaultLate : num(lateAmt)
  const refundDue = num(quote?.refund_due)
  const refundValue = refund == null ? refundDue : num(refund)
  const refundBad = refundValue < 0 || refundValue > refundDue + 0.001

  async function checkOut() {
    setBusy(true); setErr('')
    try {
      await api.post(`/stays/${stay.id}/checkout/`, { ...(lateOn && lateValue > 0 ? { late_fee: lateValue.toFixed(2) } : {}), ...damageBody })
      onDone?.()
      onClose()
    } catch (e) {
      setErr(errorText(e))
      setBusy(false)
    }
  }

  async function earlyCheckout() {
    setBusy(true); setErr('')
    try {
      await api.post(`/stays/${stay.id}/early_checkout/`, {
        date, method, ...(method === 'CUSTOM' ? { room_charge: custom } : {}),
        refund_amount: refundValue.toFixed(2), refund_method: refundMethod, notes, ...damageBody,
      })
      onDone?.()
      onClose()
    } catch (e) {
      setErr(errorText(e))
      setBusy(false)
    }
  }

  const methods = METHODS.filter((m) => !(m.notDaily && stay.rate_type === 'DAILY'))

  return (
    <Modal title={`${early ? 'Early checkout' : 'Check out'}: ${stay.guest.name}`} onClose={onClose} width={640}>
      <div className="co-sum">
        <div><span>Room</span><strong>{stay.room_number}</strong></div>
        <div><span>Booked</span><strong>{fmtDate(stay.check_in_date)} → {fmtDate(stay.check_out_date)}</strong></div>
        <div><span>Total</span><strong>{money(stay.total_amount)}</strong></div>
        <div><span>Paid</span><strong>{money(stay.amount_paid)}</strong></div>
      </div>

      {early ? (
        <>
          <Alert kind="info">
            Guest is leaving before the booked checkout ({fmtDate(stay.check_out_date)}). Choose how to charge the nights used;
            the difference is refunded.
          </Alert>
          <div className="form-grid cols-2 early-grid">
            <label>Leaving on
              <input type="date" value={date} min={stay.check_in_date} max={[today, addDays(stay.check_out_date, -1)].sort()[0]}
                onChange={(e) => { setDate(e.target.value); setRefund(null) }} />
              <span className="hint">Leaving on the check-in day counts as 1 night</span>
            </label>
            <div className="readout">
              <span>Nights used</span>
              <strong>{quote ? `${quote.nights_used} of ${quote.nights_booked}` : '…'}</strong>
              {quote && <span className="tiny muted">{quote.nights_unused} unused</span>}
            </div>
          </div>

          <div className="early-methods">
            {methods.map((m) => (
              <label key={m.key} className={`early-method ${method === m.key ? 'on' : ''}`}>
                <input type="radio" name="early-method" checked={method === m.key}
                  onChange={() => { setMethod(m.key); setRefund(null) }} />
                <span className="em-text">
                  <strong>{m.label}</strong>
                  <span className="tiny muted">{quote ? m.help(quote) : ''}</span>
                </span>
                {m.key === 'CUSTOM' ? (
                  <input type="number" step="0.01" min="0" className="em-amount" placeholder="0.00" value={custom}
                    onFocus={() => setMethod('CUSTOM')}
                    onChange={(e) => { setCustom(e.target.value); setMethod('CUSTOM'); setRefund(null) }} />
                ) : (
                  <span className="em-amount">{quote ? money(quote.options[m.key]) : ''}</span>
                )}
              </label>
            ))}
          </div>

          <Alert>{qErr}</Alert>
          {quote && (
            <table className="early-calc">
              <tbody>
                <tr><td>Room charge</td><td className="num">{money(quote.room_charge)}</td><td className="tiny muted">was {money(quote.original_room_charge)}</td></tr>
                {num(stay.extra_person_fee) > 0 && <tr><td>Extra person fee</td><td className="num">{money(quote.extra_person_fee)}</td><td className="tiny muted">{quote.method === 'NO_REFUND' ? 'kept' : `was ${money(stay.extra_person_fee)}, nights used only`}</td></tr>}
                {num(quote.kept_charges) > 0 && <tr><td>Fees (pet, card, late, early check-in, damage)</td><td className="num">{money(quote.kept_charges)}</td><td className="tiny muted">not refunded</td></tr>}
                {num(quote.adjustment) !== 0 && <tr><td>{num(quote.adjustment) < 0 ? 'Discount' : 'Adjustment'}</td><td className="num">{money(quote.adjustment)}</td><td className="tiny muted">kept</td></tr>}
                <tr className="em-total"><td>New total</td><td className="num">{money(quote.new_total)}</td><td className="tiny muted">was {money(quote.original_total)}</td></tr>
                <tr><td>Paid</td><td className="num">{money(quote.paid)}</td><td></td></tr>
                {refundDue > 0 && <tr className="em-refund"><td>Refund due</td><td className="num">{money(quote.refund_due)}</td><td></td></tr>}
                {num(quote.balance_due) > 0 && <tr className="em-owed"><td>Guest still owes</td><td className="num">{money(quote.balance_due)}</td><td className="tiny muted">stays in Balance Payments</td></tr>}
              </tbody>
            </table>
          )}

          {refundDue > 0 && (
            <div className="form-grid cols-3 early-grid">
              <label>Refund amount
                <input type="number" step="0.01" min="0" max={refundDue} value={refund ?? quote.refund_due}
                  onChange={(e) => setRefund(e.target.value)} />
                <span className="hint">{refundValue < refundDue ? `${money(refundDue - refundValue)} kept as guest credit` : 'Full refund'}</span>
              </label>
              <label>Refund by
                <select value={refundMethod} onChange={(e) => setRefundMethod(e.target.value)}>
                  <option value="CASH">Cash</option>
                  <option value="CREDIT">Card</option>
                </select>
              </label>
              <label>Note
                <input value={notes} maxLength={200} onChange={(e) => setNotes(e.target.value)} placeholder="Reason (optional)" />
              </label>
            </div>
          )}
          {refundBad && <Alert>Refund must be between $0.00 and {money(refundDue)}.</Alert>}
        </>
      ) : (
        <>
          {owes && <Alert>This guest still owes {money(stay.balance)}. Take payment before checking out, or it stays in Balance Payments.</Alert>}
          {num(stay.balance) < 0 && <Alert kind="info">Guest has paid {money(-num(stay.balance))} more than the total. Use Refund on the guest page to give it back.</Alert>}
          {hadLateFee ? (
            <p className="tiny muted">Late fee of {money(stay.late_fee)} already charged.</p>
          ) : (
            <div className={`late-box ${late ? 'is-late' : ''}`}>
              <label className="check">
                <input type="checkbox" checked={lateOn} onChange={(e) => setLateOn(e.target.checked)} />
                <span>Add late fee</span>
              </label>
              <input type="number" step="0.01" min="0" value={lateAmt === '' ? defaultLate.toFixed(2) : lateAmt}
                onChange={(e) => { setLateAmt(e.target.value); setLateOn(true) }} />
              <span className="tiny muted">
                {late ? `Past checkout time (${fmtTime(stay.check_out_time)} on ${fmtDate(stay.check_out_date)})` : `Checkout time ${fmtTime(stay.check_out_time)}`}
              </span>
            </div>
          )}
        </>
      )}

      <div className="room-condition">
        <h4>Room condition</h4>
        <PhotoUploader mode="DAMAGE" value={damagePhotos} stay={stay.id}
          onAdd={(ph) => setDamagePhotos((l) => (l.some((x) => x.id === ph.id) ? l : [...l, ph]))}
          onRemove={(ph) => { api.delete(`/photos/${ph.id}/`).catch(() => {}); setDamagePhotos((l) => l.filter((x) => x.id !== ph.id)) }} />
        <div className="form-grid cols-2 damage-grid">
          <label className="span-2">Damage notes
            <input value={damageNotes} onChange={(e) => setDamageNotes(e.target.value)} maxLength={500} placeholder="Leave empty if the room is fine" />
          </label>
          <label>Damage fee
            <input type="number" step="0.01" min="0" value={damageFee} onChange={(e) => setDamageFee(e.target.value)} placeholder="0.00" />
            <span className="hint">Added to the guest's bill{early ? '; reduces the refund' : ''}</span>
          </label>
          <label className="check dnr-check-box">
            <input type="checkbox" checked={addDnr} onChange={(e) => setAddDnr(e.target.checked)} />
            <span>Also add guest to the <strong>DNR list</strong></span>
          </label>
        </div>
      </div>

      <Alert>{err}</Alert>
      <div className="co-actions">
        <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        {early ? (
          <button className="btn btn-primary" onClick={earlyCheckout} disabled={busy || !quote || refundBad}>
            {busy ? 'Saving…' : refundValue > 0 ? `Check out & refund ${money(refundValue)}` : 'Confirm early checkout'}
          </button>
        ) : (
          <>
            <button className="btn" onClick={checkOut} disabled={busy}>
              {busy ? 'Checking out…' : lateOn && lateValue > 0 ? `Check out + ${money(lateValue)} late fee` : 'Check out'}
            </button>
            <button className="btn btn-primary" disabled={busy} onClick={() => navigate(`/check-in?renew=${stay.id}`)}>
              Check out &amp; check in again
            </button>
          </>
        )}
      </div>
      {!early && (
        <p className="tiny muted co-help">
          <strong>Check in again</strong> opens a new check-in with this guest, room and rate filled in.
          It is saved as a new entry, and this stay is checked out when you save it.
        </p>
      )}
      {early && (
        <p className="tiny muted co-help">
          The room becomes available right away. <strong>Undo checkout</strong> on the guest page restores the booked dates and charges;
          a refund already given stays on record.
        </p>
      )}
    </Modal>
  )
}
