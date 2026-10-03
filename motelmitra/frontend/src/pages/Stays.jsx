import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import api, { errorText } from '../api'
import StaysTable from '../components/StaysTable'
import { Alert, PageHead, PaymentModal } from '../components/ui'

/** Search all guest stays by name, phone, plate or room, with optional date filter. */
export default function Stays({ balancesOnly = false }) {
  const [q, setQ] = useState('')
  const [date, setDate] = useState('')
  const [status, setStatus] = useState('')
  const [rows, setRows] = useState(null)
  const [err, setErr] = useState('')
  const [paying, setPaying] = useState(null)

  const load = useCallback(() => {
    const params = {}
    if (q) params.q = q
    if (date) params.date = date
    if (status) params.status = status
    if (balancesOnly) params.has_balance = 1
    api.get('/stays/', { params }).then((r) => { setRows(r.data); setErr('') }).catch((e) => setErr(errorText(e)))
  }, [q, date, status, balancesOnly])

  useEffect(() => {
    const t = setTimeout(load, 250)
    return () => clearTimeout(t)
  }, [load])

  const owed = rows?.reduce((a, s) => a + Number(s.balance), 0) || 0

  return (
    <>
      <PageHead
        title={balancesOnly ? 'Balance Payments' : 'Guests'}
        sub={balancesOnly ? `${rows?.length ?? 0} guests owe ${owed.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}` : 'All check-ins'}
      >
        {!balancesOnly && <Link to="/check-in" className="btn btn-primary">+ New Check-in</Link>}
      </PageHead>
      <div className="filters">
        <input className="search" placeholder="Search name, phone, plate or room…" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="inline">Staying on
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        {!balancesOnly && (
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            <option value="CHECKED_IN">In house</option>
            <option value="CHECKED_OUT">Checked out</option>
          </select>
        )}
        {(q || date || status) && <button className="btn" onClick={() => { setQ(''); setDate(''); setStatus('') }}>Clear</button>}
      </div>
      <Alert>{err}</Alert>
      <div className="card no-pad">
        {rows && <StaysTable stays={rows} actions={{ onPay: setPaying }} empty={balancesOnly ? 'No open balances. 🎉' : 'No guests found.'} />}
      </div>
      {paying && <PaymentModal stay={paying} onClose={() => setPaying(null)} onSaved={() => { setPaying(null); load() }} />}
    </>
  )
}
