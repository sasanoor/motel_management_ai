import { useState } from 'react'
import api, { errorText } from '../api'
import { useAuth } from '../auth'
import { fmtDate, todayISO } from '../utils'
import { Alert, Modal } from './ui'

/**
 * Add or edit an expense (Today's Report > Cash drawer).
 * Clerk = the logged-in user. Front desk: current business day only; the admin can pick another date.
 */
export default function ExpenseModal({ expense, date, onClose, onSaved }) {
  const { user, isAdmin } = useAuth()
  const editing = Boolean(expense?.id)
  const [f, setF] = useState({
    business_date: expense?.business_date || date || todayISO(),
    amount: expense?.amount || '',
    method: expense?.method || 'CASH',
    description: expense?.description || '',
  })
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }))

  async function save(e) {
    e.preventDefault()
    setBusy(true); setErr('')
    try {
      const body = { ...f }
      if (!isAdmin) delete body.business_date      // front desk: always the current business day
      const { data } = editing
        ? await api.patch(`/expenses/${expense.id}/`, body)
        : await api.post('/expenses/', body)
      onSaved(data)
    } catch (e2) { setErr(errorText(e2)); setBusy(false) }
  }

  return (
    <Modal title={editing ? 'Edit expense' : 'Add expense'} onClose={onClose}>
      <Alert>{err}</Alert>
      <form onSubmit={save} className="form-grid cols-2">
        <label>Date
          {isAdmin
            ? <input type="date" value={f.business_date} max={todayISO() > date ? todayISO() : date} onChange={set('business_date')} required />
            : <input value={fmtDate(f.business_date)} disabled />}
          {!isAdmin && <span className="hint">Today's business day</span>}
        </label>
        <label><span>Amount <span className="req">*</span></span>
          <input type="number" step="0.01" min="0.01" value={f.amount} onChange={set('amount')} required autoFocus placeholder="0.00" />
        </label>
        <label>Paid by
          <div className="seg">
            {[['CASH', 'Cash'], ['CREDIT', 'Card'], ['CHECK', 'Check']].map(([k, label]) => (
              <button type="button" key={k} className={f.method === k ? 'on' : ''} onClick={() => setF((p) => ({ ...p, method: k }))}>{label}</button>
            ))}
          </div>
          <span className="hint">{f.method === 'CASH' ? 'Taken out of the cash drawer' : f.method === 'CHECK' ? 'Paid with a motel check' : 'Paid with the motel card'}</span>
        </label>
        <label>Clerk
          <input value={expense?.clerk_name || user.full_name} disabled />
        </label>
        <label className="span-2"><span>Description <span className="req">*</span></span>
          <input value={f.description} onChange={set('description')} required maxLength={255} placeholder="e.g. Bleach and towels, Walmart" />
        </label>
        <div className="span-2 form-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : editing ? 'Save' : 'Add expense'}</button>
        </div>
      </form>
    </Modal>
  )
}
