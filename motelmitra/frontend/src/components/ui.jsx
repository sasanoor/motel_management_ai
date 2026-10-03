import { useState } from 'react'
import api, { errorText } from '../api'
import { money, num } from '../utils'

export function Modal({ title, onClose, children, width = 520 }) {
  return (
    <div className="modal-back" onMouseDown={onClose}>
      <div className="modal" style={{ maxWidth: width }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  )
}

export function Alert({ kind = 'error', children }) {
  if (!children) return null
  return <div className={`alert alert-${kind}`}>{children}</div>
}

export function PageHead({ title, sub, children }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {sub && <p className="muted">{sub}</p>}
      </div>
      <div className="page-actions">{children}</div>
    </div>
  )
}

export function Stat({ label, value, tone }) {
  return (
    <div className={`stat ${tone ? 'stat-' + tone : ''}`}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  )
}

export function StatusPill({ stay }) {
  if (stay.is_deleted) return <span className="pill pill-grey">Deleted</span>
  return stay.status === 'CHECKED_OUT'
    ? <span className="pill pill-grey">Checked out</span>
    : <span className="pill pill-green">In house</span>
}

export function BalanceCell({ value }) {
  const n = num(value)
  return <span className={n > 0 ? 'owed' : n < 0 ? 'credit-bal' : ''}>{money(n)}</span>
}

export function Empty({ children }) {
  return <div className="empty">{children}</div>
}

/** Add a balance payment to a stay. */
export function PaymentModal({ stay, onClose, onSaved }) {
  const [amount, setAmount] = useState(num(stay.balance) > 0 ? num(stay.balance).toFixed(2) : '')
  const [method, setMethod] = useState('CASH')
  const [notes, setNotes] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  async function save(e) {
    e.preventDefault()
    setBusy(true)
    setErr('')
    try {
      const { data } = await api.post(`/stays/${stay.id}/payments/`, { amount, method, notes })
      onSaved(data)
    } catch (e2) {
      setErr(errorText(e2))
      setBusy(false)
    }
  }

  return (
    <Modal title={`Payment: ${stay.guest.name}, Room ${stay.room_number}`} onClose={onClose}>
      <div className="pay-summary">
        <div><span>Total</span><strong>{money(stay.total_amount)}</strong></div>
        <div><span>Paid</span><strong>{money(stay.amount_paid)}</strong></div>
        <div><span>Balance</span><strong className="owed">{money(stay.balance)}</strong></div>
      </div>
      <Alert>{err}</Alert>
      <form onSubmit={save} className="form-grid cols-2">
        <label>Amount
          <input type="number" step="0.01" min="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required autoFocus />
        </label>
        <label>Method
          <div className="seg">
            {['CASH', 'CREDIT'].map((m) => (
              <button type="button" key={m} className={method === m ? 'on' : ''} onClick={() => setMethod(m)}>
                {m === 'CASH' ? 'Cash' : 'Credit'}
              </button>
            ))}
          </div>
        </label>
        <label className="span-2">Notes
          <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
        </label>
        <div className="span-2 form-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Add payment'}</button>
        </div>
      </form>
    </Modal>
  )
}
