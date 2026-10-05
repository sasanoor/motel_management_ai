import { useEffect, useState } from 'react'
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

export function Stat({ label, value, tone, onClick }) {
  const cls = `stat ${tone ? 'stat-' + tone : ''} ${onClick ? 'stat-click' : ''}`
  if (onClick) {
    return (
      <button type="button" className={cls} onClick={onClick}>
        <div className="stat-value">{value}</div>
        <div className="stat-label">{label} <span className="stat-go">›</span></div>
      </button>
    )
  }
  return (
    <div className={cls}>
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
/**
 * Balance payment, laid out like the check-in "Payment collected" section:
 * cash and / or card, card fee on the card amount, "Put balance on card".
 */
export function PaymentModal({ stay, onClose, onSaved }) {
  const owed = Math.max(num(stay.balance), 0)
  const [cash, setCash] = useState(owed ? owed.toFixed(2) : '')
  const [credit, setCredit] = useState('')
  const [fee, setFee] = useState(null)            // null = auto (% of card amount)
  const [pct, setPct] = useState(0)
  const [adj, setAdj] = useState(0)              // balance edited: + extra charge, - discount
  const [balanceText, setBalanceText] = useState(null)
  const [notes, setNotes] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => { api.get('/settings/').then((r) => setPct(num(r.data.card_fee_percent))).catch(() => {}) }, [])

  const r2 = (n) => Math.round(n * 100) / 100
  const cardFee = fee ?? r2((num(credit) * pct) / 100)
  const base = r2(num(stay.balance) + cardFee - num(cash) - num(credit))   // balance before any edit
  const after = r2(base + adj)
  const paying = num(cash) + num(credit)

  // Clerk types a balance: keep the payment, store the difference as an adjustment (same as check-in).
  function editBalance(e) {
    const text = e.target.value
    setBalanceText(text)
    if (text === '' || isNaN(Number(text))) return
    setAdj(r2(Number(text) - base))
  }

  function balanceOnCard() {
    const due = owed + adj - num(cash)
    if (due <= 0) return
    const c = fee == null ? due / (1 - pct / 100) : due + num(fee)
    setCredit(r2(c).toFixed(2))
  }

  async function save(e) {
    e.preventDefault()
    setBusy(true)
    setErr('')
    try {
      const { data } = await api.post(`/stays/${stay.id}/payments/`, {
        cash: num(cash).toFixed(2), credit: num(credit).toFixed(2), card_fee: cardFee.toFixed(2), adjustment_change: adj.toFixed(2), notes,
      })
      onSaved(data)
    } catch (e2) {
      setErr(errorText(e2))
      setBusy(false)
    }
  }

  return (
    <Modal title={`Payment: ${stay.guest.name}, Room ${stay.room_number}`} onClose={onClose} width={600}>
      <div className="pay-summary">
        <div><span>Total</span><strong>{money(stay.total_amount)}</strong></div>
        <div><span>Paid</span><strong>{money(stay.amount_paid)}</strong></div>
        <div><span>Balance</span><strong className="owed">{money(stay.balance)}</strong></div>
      </div>
      <Alert>{err}</Alert>
      <form onSubmit={save} className="form-grid cols-2">
        <div className="subhead span-2">Payment collected</div>
        <label>Cash
          <input type="number" step="0.01" min="0" value={cash} onChange={(e) => setCash(e.target.value)} placeholder="0.00" autoFocus />
        </label>
        <label>Credit / card
          <input type="number" step="0.01" min="0" value={credit} onChange={(e) => setCredit(e.target.value)} placeholder="0.00" />
          <button type="button" className="link-btn" onClick={balanceOnCard}>Put balance on card</button>
        </label>
        <label>Card fee
          <span className="fee-input">
            <input type="number" step="0.01" min="0" value={fee ?? cardFee}
              onChange={(e) => setFee(e.target.value === '' ? 0 : Number(e.target.value))} />
            {fee != null && <button type="button" className="fee-reset" title="Back to auto" onClick={() => setFee(null)}>↺</button>}
          </span>
          <span className="hint">{pct}% of the card amount, added to the guest's charges</span>
        </label>
        <label>Balance after payment
          <input
            type="number" step="0.01"
            className={after > 0 ? 'input-owed' : ''}
            value={balanceText ?? after.toFixed(2)}
            onFocus={(e) => { setBalanceText(after.toFixed(2)); e.target.select() }}
            onChange={editBalance}
            onBlur={() => setBalanceText(null)}
          />
          {after < 0 && <span className="hint">More than owed; guest will be in credit</span>}
        </label>
        {adj !== 0 && (
          <div className="adj-note span-2">
            Balance edited: {adj > 0 ? 'an extra charge of' : 'a discount of'} <strong>{money(Math.abs(adj))}</strong> will
            be added to the stay (total {money(stay.total_amount)} → {money(num(stay.total_amount) + cardFee + adj)}).
            <button type="button" className="btn btn-sm ml" onClick={() => setAdj(0)}>Reset</button>
          </div>
        )}
        <label className="span-2">Notes
          <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
        </label>
        <div className="span-2 form-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || (paying <= 0 && adj === 0) || num(stay.total_amount) + cardFee + adj < 0}>
            {busy ? 'Saving…' : paying > 0 ? `Take payment ${money(paying)}` : 'Save balance'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

/** Give money back to a guest who paid more than the total (balance below zero). */
export function RefundModal({ stay, onClose, onSaved }) {
  const over = Math.max(-num(stay.balance), 0)
  const [amount, setAmount] = useState(over.toFixed(2))
  const [method, setMethod] = useState('CASH')
  const [notes, setNotes] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  async function save(e) {
    e.preventDefault()
    setBusy(true)
    setErr('')
    try {
      const { data } = await api.post(`/stays/${stay.id}/refund/`, { amount, method, notes })
      onSaved(data)
    } catch (e2) {
      setErr(errorText(e2))
      setBusy(false)
    }
  }

  return (
    <Modal title={`Refund: ${stay.guest.name}, Room ${stay.room_number}`} onClose={onClose}>
      <div className="pay-summary">
        <div><span>Total</span><strong>{money(stay.total_amount)}</strong></div>
        <div><span>Paid</span><strong>{money(stay.amount_paid)}</strong></div>
        <div><span>Overpaid</span><strong className="credit-bal">{money(over)}</strong></div>
      </div>
      <Alert>{err}</Alert>
      <form onSubmit={save} className="form-grid cols-2">
        <label>Refund amount
          <input type="number" step="0.01" min="0.01" max={over} value={amount} onChange={(e) => setAmount(e.target.value)} required autoFocus />
        </label>
        <label>Refund by
          <div className="seg">
            {['CASH', 'CREDIT'].map((m) => (
              <button type="button" key={m} className={method === m ? 'on' : ''} onClick={() => setMethod(m)}>
                {m === 'CASH' ? 'Cash' : 'Card'}
              </button>
            ))}
          </div>
        </label>
        <label className="span-2">Notes
          <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Reason (optional)" />
        </label>
        <div className="span-2 form-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : `Refund ${money(amount)}`}</button>
        </div>
      </form>
    </Modal>
  )
}
