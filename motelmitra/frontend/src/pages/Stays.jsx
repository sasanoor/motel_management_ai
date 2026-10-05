import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import api, { errorText } from '../api'
import StaysTable from '../components/StaysTable'
import { Alert, PageHead, Pagination, PaymentModal } from '../components/ui'

/** Search all guest stays by name, phone, plate or room, with optional date filter. */
export default function Stays({ balancesOnly = false }) {
  const [q, setQ] = useState('')
  const [date, setDate] = useState('')
  const [status, setStatus] = useState('')
  const [data, setData] = useState(null)        // one page: { count, page, pages, results, owed }
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [err, setErr] = useState('')
  const [paying, setPaying] = useState(null)

  const load = useCallback(() => {
    const params = { page, page_size: pageSize }
    if (q) params.q = q
    if (date) params.date = date
    if (status) params.status = status
    if (balancesOnly) params.has_balance = 1
    api.get('/stays/', { params }).then((r) => { setData(r.data); setErr('') }).catch((e) => setErr(errorText(e)))
  }, [q, date, status, balancesOnly, page, pageSize])

  // a new search or filter starts again at page 1
  const filter = (setter) => (v) => { setter(v); setPage(1) }
  const rows = data?.results

  useEffect(() => {
    const t = setTimeout(load, 250)
    return () => clearTimeout(t)
  }, [load])

  const owed = Number(data?.owed || 0)

  return (
    <>
      <PageHead
        title={balancesOnly ? 'Balance Payments' : 'Guests'}
        sub={balancesOnly ? `${data?.count ?? 0} guests owe ${owed.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}` : 'All check-ins'}
      >
        {!balancesOnly && <Link to="/check-in" className="btn btn-primary">+ New Check-in</Link>}
      </PageHead>
      <div className="filters">
        <input className="search" placeholder="Search name, phone, plate or room…" value={q} onChange={(e) => filter(setQ)(e.target.value)} />
        <label className="inline">Staying on
          <input type="date" value={date} onChange={(e) => filter(setDate)(e.target.value)} />
        </label>
        {!balancesOnly && (
          <select value={status} onChange={(e) => filter(setStatus)(e.target.value)}>
            <option value="">All statuses</option>
            <option value="CHECKED_IN">In house</option>
            <option value="CHECKED_OUT">Checked out</option>
          </select>
        )}
        {(q || date || status) && <button className="btn" onClick={() => { setQ(''); setDate(''); setStatus(''); setPage(1) }}>Clear</button>}
      </div>
      <Alert>{err}</Alert>
      <div className="card no-pad">
        {rows && <StaysTable stays={rows} actions={{ onPay: setPaying }} empty={balancesOnly ? 'No open balances. 🎉' : 'No guests found.'} />}
        {data && (
          <Pagination page={data.page} pages={data.pages} count={data.count} pageSize={pageSize}
            onPage={(n) => { setPage(n); window.scrollTo({ top: 0, behavior: 'smooth' }) }}
            onPageSize={(n) => { setPageSize(n); setPage(1) }} />
        )}
      </div>
      {paying && <PaymentModal stay={paying} onClose={() => setPaying(null)} onSaved={() => { setPaying(null); load() }} />}
    </>
  )
}
