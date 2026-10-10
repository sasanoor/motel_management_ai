import { useState } from 'react'
import api, { errorText } from '../api'
import usePayment from '../usePayment'
import PaymentCollected from './PaymentCollected'
import { money, num, HK } from '../utils'

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

/** Room housekeeping status pill. Ready is hidden unless showReady. */
export function HkPill({ status, note, showReady = false }) {
  if (!status || (status === 'READY' && !showReady)) return null
  const h = HK[status] || { label: status, cls: 'pill-grey' }
  return <span className={`pill hk-pill ${h.cls}`} title={note || h.label}>{h.label}</span>
}

/** ⚠ open room problems badge */
export function IssueBadge({ count }) {
  if (!count) return null
  return <span className="pill pill-red issue-badge" title={`${count} open room problem${count === 1 ? '' : 's'}`}>⚠ {count}</span>
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

export function Stat({ label, value, tone, onClick, sub }) {
  const cls = `stat ${tone ? 'stat-' + tone : ''} ${onClick ? 'stat-click' : ''}`
  if (onClick) {
    return (
      <button type="button" className={cls} onClick={onClick}>
        <div className="stat-value">{value}</div>
        <div className="stat-label">{label} <span className="stat-go">›</span></div>
        {sub && <div className="stat-sub">{sub}</div>}
      </button>
    )
  }
  return (
    <div className={cls}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      {sub && <div className="stat-sub">{sub}</div>}
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
/** Balance payment: same "Extra charges" + "Payment collected" layout as the check-in page. */
export function PaymentModal({ stay, onClose, onSaved }) {
  const owed = Math.max(num(stay.balance), 0)
  const p = usePayment(owed)   // nothing pre-filled: the clerk types cash, card or check
  const [notes, setNotes] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  async function save(e) {
    e.preventDefault()
    setBusy(true)
    setErr('')
    try {
      const { data } = await api.post(`/stays/${stay.id}/payments/`, { ...p.body(), notes })
      onSaved(data)
    } catch (e2) {
      setErr(errorText(e2))
      setBusy(false)
    }
  }

  return (
    <Modal title={`Payment: ${stay.guest.name}, Room ${stay.room_number}`} onClose={onClose} width={860}>
      <div className="pay-summary">
        <div><span>Total</span><strong>{money(stay.total_amount)}</strong></div>
        <div><span>Paid</span><strong>{money(stay.amount_paid)}</strong></div>
        <div><span>Balance</span><strong className="owed">{money(stay.balance)}</strong></div>
      </div>
      <Alert>{err}</Alert>
      <form onSubmit={save}>
        <PaymentCollected p={p} totalNote={<><span>Owed now</span><strong>{money(p.owedNow)}</strong>{p.cardFee > 0 && <span className="tiny muted">{money(owed)} + card fee {money(p.cardFee)}</span>}</>} />
        <div className="form-grid cols-4">
          <label className="span-4">Notes
            <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
          </label>
        </div>
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || (p.paying <= 0 && p.adj === 0) || num(stay.total_amount) + p.cardFee + p.adj < 0}>
            {busy ? 'Saving…' : p.paying > 0 ? `Take payment ${money(p.paying)}` : 'Save balance'}
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
            {['CASH', 'CREDIT', 'CHECK'].map((m) => (
              <button type="button" key={m} className={method === m ? 'on' : ''} onClick={() => setMethod(m)}>
                {{ CASH: 'Cash', CREDIT: 'Card', CHECK: 'Check' }[m]}
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

/** Page links under a list: "Showing 26–50 of 312", rows per page, ‹ 1 … 4 5 6 … 13 ›. */
export function Pagination({ page, pages, count, pageSize, onPage, onPageSize, sizes = [25, 50, 100] }) {
  if (!count) return null
  const from = (page - 1) * pageSize + 1
  const to = Math.min(page * pageSize, count)
  const nums = []
  for (let i = 1; i <= pages; i++) {
    if (i === 1 || i === pages || Math.abs(i - page) <= 2) nums.push(i)
    else if (nums[nums.length - 1] !== '…') nums.push('…')
  }
  return (
    <div className="pager">
      <span className="muted">Showing <strong>{from}–{to}</strong> of <strong>{count}</strong></span>
      <div className="pager-pages">
        <button className="btn btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>‹ Prev</button>
        {nums.map((n, i) => n === '…'
          ? <span key={`g${i}`} className="pager-gap">…</span>
          : <button key={n} className={`btn btn-sm ${n === page ? 'btn-primary' : ''}`} onClick={() => onPage(n)}>{n}</button>)}
        <button className="btn btn-sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next ›</button>
      </div>
      {onPageSize && (
        <label className="inline pager-size">Rows
          <select value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))}>
            {sizes.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      )}
    </div>
  )
}
