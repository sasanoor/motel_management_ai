import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api, { errorText } from '../api'
import { confirmBox } from '../confirm'
import { addDays, fmtDate, money, num, todayISO, csvCell } from '../utils'
import { Alert, Empty } from './ui'

// Reports -> Custom reports. Pick a source, columns, filters, group by and sort; run, save, export, print.

const OPS = {
  text: [['contains', 'contains'], ['is', 'is'], ['not', 'is not'], ['starts', 'starts with'], ['empty', 'is empty'], ['not_empty', 'is not empty']],
  choice: [['is', 'is'], ['not', 'is not'], ['contains', 'contains']],
  money: [['gt', '>'], ['gte', '≥'], ['lt', '<'], ['lte', '≤'], ['eq', '='], ['ne', '≠']],
  int: [['gt', '>'], ['gte', '≥'], ['lt', '<'], ['lte', '≤'], ['eq', '='], ['ne', '≠']],
  date: [['on', 'on'], ['after', 'after'], ['before', 'before'], ['gte', 'on or after'], ['lte', 'on or before']],
}
const BUCKETS = [['day', 'Day'], ['week', 'Week'], ['month', 'Month'], ['weekday', 'Weekday'], ['year', 'Year']]

function monthStart(iso) { return `${iso.slice(0, 8)}01` }
function lastMonth(iso) {
  const d = new Date(`${monthStart(iso)}T12:00:00`); d.setDate(0)
  const end = d.toISOString().slice(0, 10)
  return [monthStart(end), end]
}
const RANGES = [
  ['today', 'Today', (t) => [t, t]],
  ['yesterday', 'Yesterday', (t) => [addDays(t, -1), addDays(t, -1)]],
  ['7', 'Last 7 days', (t) => [addDays(t, -6), t]],
  ['month', 'This month', (t) => [monthStart(t), t]],
  ['lastmonth', 'Last month', (t) => lastMonth(t)],
  ['30', 'Last 30 days', (t) => [addDays(t, -29), t]],
  ['90', 'Last 90 days', (t) => [addDays(t, -89), t]],
  ['year', 'This year', (t) => [`${t.slice(0, 4)}-01-01`, t]],
]

// Ready-made reports: one click, then change anything and save under your own name.
const TEMPLATES = [
  { name: 'Revenue by room type', range: 'month', config: { source: 'stays', columns: ['room_type', 'nights', 'total', 'cash', 'credit', 'check', 'balance'], group_by: 'room_type', sort: 'total', sort_dir: 'desc' } },
  { name: 'Revenue by month', range: 'year', config: { source: 'stays', columns: ['check_in', 'nights', 'total', 'cash', 'credit', 'check', 'balance'], group_by: 'check_in', group_bucket: 'month', sort: 'check_in' } },
  { name: 'Cash vs card vs check by day', range: '7', config: { source: 'payments', columns: ['date', 'cash', 'credit', 'check', 'amount'], group_by: 'date', group_bucket: 'day', sort: 'date' } },
  { name: 'Collections by clerk', range: '7', config: { source: 'payments', columns: ['clerk', 'cash', 'credit', 'check', 'amount'], group_by: 'clerk', sort: 'amount', sort_dir: 'desc' } },
  { name: 'Guests owing money', range: '90', config: { source: 'stays', columns: ['room', 'guest', 'phone', 'check_in', 'check_out', 'total', 'paid', 'balance'], filters: [{ field: 'balance', op: 'gt', value: '0' }], sort: 'balance', sort_dir: 'desc' } },
  { name: 'Repeat guests', range: 'year', config: { source: 'guests', columns: ['guest', 'phone', 'stays', 'nights', 'last_stay', 'total', 'balance'], filters: [{ field: 'stays', op: 'gte', value: '2' }], sort: 'stays', sort_dir: 'desc' } },
  { name: 'Weekly and monthly guests', range: '90', config: { source: 'stays', columns: ['room', 'guest', 'rate_type', 'check_in', 'check_out', 'total', 'balance', 'status'], filters: [{ field: 'rate_type', op: 'not', value: 'Daily' }], sort: 'check_in', sort_dir: 'desc' } },
  { name: 'Refunds given', range: '30', config: { source: 'payments', columns: ['date', 'time', 'guest', 'room', 'method', 'amount', 'clerk', 'notes'], filters: [{ field: 'type', op: 'is', value: 'Refund' }], sort: 'date', sort_dir: 'desc' } },
  { name: 'Expenses by month', range: 'year', config: { source: 'expenses', columns: ['date', 'cash', 'credit', 'check', 'amount'], group_by: 'date', group_bucket: 'month', sort: 'date' } },
  { name: 'Busiest weekdays', range: '90', config: { source: 'stays', columns: ['check_in', 'nights', 'total'], group_by: 'check_in', group_bucket: 'weekday', sort: '_count', sort_dir: 'desc' } },
  { name: 'Problems by room', range: '90', config: { source: 'problems', columns: ['room', 'days_open'], group_by: 'room', sort: '_count', sort_dir: 'desc' } },
  { name: 'Problems by type', range: '90', config: { source: 'problems', columns: ['category', 'days_open'], group_by: 'category', sort: '_count', sort_dir: 'desc' } },
  { name: 'Open room problems', range: 'year', config: { source: 'problems', columns: ['reported', 'room', 'category', 'priority', 'description', 'status', 'reported_by', 'days_open'], filters: [{ field: 'status', op: 'not', value: 'Fixed' }], sort: 'days_open', sort_dir: 'desc' } },
  { name: 'DNR guests who stayed', range: 'year', config: { source: 'stays', columns: ['room', 'guest', 'phone', 'dl', 'check_in', 'total', 'balance'], filters: [{ field: 'dnr', op: 'is', value: 'Yes' }], sort: 'check_in', sort_dir: 'desc' } },
]

// starting columns for a new report on each source
const DEFAULT_COLUMNS = {
  stays: ['room', 'guest', 'check_in', 'check_out', 'nights', 'total', 'paid', 'balance'],
  payments: ['date', 'time', 'type', 'method', 'amount', 'guest', 'room', 'clerk'],
  expenses: ['date', 'description', 'method', 'amount', 'clerk'],
  guests: ['guest', 'phone', 'stays', 'nights', 'last_stay', 'total', 'balance'],
  problems: ['reported', 'room', 'category', 'priority', 'description', 'status', 'reported_by', 'days_open'],
}

function blank(source = 'stays') {
  const [start, end] = RANGES.find((r) => r[0] === 'month')[2](todayISO())
  return { source, date_field: '', start, end, columns: [...(DEFAULT_COLUMNS[source] || [])], filters: [], group_by: '', group_bucket: 'day', sort: '', sort_dir: 'asc' }
}

function fmtCell(v, type) {
  if (v === null || v === undefined || v === '') return ''
  if (type === 'money') return money(v)
  if (type === 'date') return /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? fmtDate(v) : v
  return v
}

function downloadCSV(name, header, rows) {
  const esc = csvCell
  const csv = [header.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\n')
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
  a.download = `${name.replace(/[^\w-]+/g, '_')}.csv`
  a.click()
}

export default function CustomReports() {
  const navigate = useNavigate()
  const [cat, setCat] = useState(null)        // { sources, choices }
  const [saved, setSaved] = useState([])
  const [cfg, setCfg] = useState(blank())
  const [range, setRange] = useState('month')
  const [current, setCurrent] = useState(null) // saved report being edited { id, name, can_change } or template { name }
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  const [naming, setNaming] = useState(null)   // name box for "Save report" (no browser popup)

  const loadSaved = () => api.get('/custom-reports/').then((r) => setSaved(r.data)).catch(() => {})
  useEffect(() => {
    api.get('/reports/custom/fields/').then((r) => setCat(r.data)).catch((e) => setErr(errorText(e)))
    loadSaved()
  }, [])

  const src = useMemo(() => cat?.sources.find((s) => s.key === cfg.source), [cat, cfg.source])
  const fieldMap = useMemo(() => Object.fromEntries((src?.fields || []).map((f) => [f.key, f])), [src])
  const columns = cfg.columns.length ? cfg.columns.filter((c) => fieldMap[c]) : (src?.fields || []).slice(0, 6).map((f) => f.key)
  const set = (patch) => { setCfg((c) => ({ ...c, ...patch })); setMsg('') }

  function applyRange(key) {
    setRange(key)
    const r = RANGES.find((x) => x[0] === key)
    if (r) { const [start, end] = r[2](todayISO()); set({ start, end }) }
  }

  async function run(c = cfg) {
    setBusy(true); setErr('')
    try {
      const body = { ...c, columns: c.columns.length ? c.columns : columns }
      const { data } = await api.post('/reports/custom/run/', body)
      setResult(data)
    } catch (e) { setErr(errorText(e)); setResult(null) } finally { setBusy(false) }
  }

  function openConfig(config, meta, rangeKey) {
    const c = { ...blank(config.source), ...config, filters: config.filters || [], columns: config.columns || [] }
    if (rangeKey) {
      const r = RANGES.find((x) => x[0] === rangeKey)
      if (r) { const [start, end] = r[2](todayISO()); c.start = start; c.end = end }
      setRange(rangeKey)
    } else setRange(c.range || '')
    if (c.range) { const r = RANGES.find((x) => x[0] === c.range); if (r) { const [start, end] = r[2](todayISO()); c.start = start; c.end = end } }
    setCfg(c); setCurrent(meta); setMsg(''); setErr('')
    run(c)
  }

  async function save(asNew) {
    const config = { ...cfg, columns, range }
    if (!asNew && current?.id) {
      try { await api.patch(`/custom-reports/${current.id}/`, { config }); setMsg(`"${current.name}" saved.`); loadSaved() } catch (e) { setErr(errorText(e)) }
      return
    }
    if (naming === null) { setNaming(current?.name && !current.id ? current.name : ''); return }
    const name = naming
    if (!name.trim()) { setErr('Give the report a name.'); return }
    try {
      const { data } = await api.post('/custom-reports/', { name: name.trim(), config })
      setCurrent({ id: data.id, name: data.name, can_change: true }); setNaming(null); setErr('')
      setMsg(`Saved as "${data.name}". Everyone at the motel can run it.`); loadSaved()
    } catch (e) { setErr(errorText(e)) }
  }

  async function remove(r) {
    if (!(await confirmBox({ title: 'Delete saved report?', details: [['Report', r.name], ['Saved by', r.created_by_name || '-']] }))) return
    try { await api.delete(`/custom-reports/${r.id}/`); if (current?.id === r.id) setCurrent(null); loadSaved() } catch (e) { setErr(errorText(e)) }
  }

  function exportCSV() {
    if (!result) return
    const name = `${current?.name || 'custom_report'}_${result.start}_${result.end}`
    downloadCSV(name, result.columns.map((c) => c.label), result.rows)
  }

  if (!cat) return <><Alert>{err}</Alert>{!err && <Empty>Loading…</Empty>}</>

  const groupable = (src?.fields || []).filter((f) => f.type !== 'money' && f.type !== 'int')
  const sortable = result?.columns || columns.map((k) => ({ key: k, label: fieldMap[k]?.label }))
  const filterValue = (f, i) => {
    const fd = fieldMap[f.field]
    if (!fd || f.op === 'empty' || f.op === 'not_empty') return null
    const upd = (v) => set({ filters: cfg.filters.map((x, j) => (j === i ? { ...x, value: v } : x)) })
    const opts = cat.choices_by_source?.[cfg.source]?.[f.field] || cat.choices[f.field]
    if (fd.type === 'choice' && opts && f.op !== 'contains') {
      return <select value={f.value || ''} onChange={(e) => upd(e.target.value)}><option value="">(pick)</option>{opts.map((o) => <option key={o}>{o}</option>)}</select>
    }
    return <input type={fd.type === 'date' ? 'date' : (fd.type === 'money' || fd.type === 'int') ? 'number' : 'text'} step="any" value={f.value || ''} onChange={(e) => upd(e.target.value)} placeholder="value" />
  }

  return (
    <div className="cr-layout">
      <aside className="cr-side no-print">
        <div className="card cr-list">
          <div className="cr-list-title">Ready-made</div>
          {TEMPLATES.map((t) => (
            <button key={t.name} type="button" className={`cr-item ${current?.name === t.name && !current.id ? 'on' : ''}`}
              onClick={() => openConfig(t.config, { name: t.name }, t.range)}>{t.name}</button>
          ))}
        </div>
        <div className="card cr-list">
          <div className="cr-list-title">Saved reports ({saved.length})</div>
          {!saved.length && <div className="tiny muted">Build a report and press Save. It shows here for everyone at the motel.</div>}
          {saved.map((r) => (
            <div key={r.id} className={`cr-item cr-saved ${current?.id === r.id ? 'on' : ''}`}>
              <button type="button" className="cr-open" onClick={() => openConfig(r.config, { id: r.id, name: r.name, can_change: r.can_change })}>
                {r.name}<span className="tiny muted">{r.created_by_name}</span>
              </button>
              {r.can_change && <button type="button" className="cr-del" title="Delete" onClick={() => remove(r)}>✕</button>}
            </div>
          ))}
        </div>
      </aside>

      <section className="cr-main">
        <div className="card cr-builder no-print">
          <div className="cr-head">
            <strong>{current?.name || 'New report'}</strong>
            {current && <button type="button" className="link-btn" onClick={() => { setCfg(blank(cfg.source)); setCurrent(null); setResult(null); setRange('month') }}>Start a new one</button>}
          </div>

          <div className="cr-row">
            <label>Data
              <select value={cfg.source} onChange={(e) => { set({ ...blank(e.target.value), start: cfg.start, end: cfg.end }); setResult(null) }}>
                {cat.sources.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
            </label>
            {src && Object.keys(src.date_fields).length > 1 && (
              <label>Date is
                <select value={cfg.date_field || Object.keys(src.date_fields)[0]} onChange={(e) => set({ date_field: e.target.value })}>
                  {Object.entries(src.date_fields).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </label>
            )}
            <label>Period
              <select value={range} onChange={(e) => applyRange(e.target.value)}>
                <option value="">Custom dates</option>
                {RANGES.map(([k, t]) => <option key={k} value={k}>{t}</option>)}
              </select>
            </label>
            <label>From <input type="date" value={cfg.start} onChange={(e) => { setRange(''); set({ start: e.target.value }) }} /></label>
            <label>To <input type="date" value={cfg.end} min={cfg.start} onChange={(e) => { setRange(''); set({ end: e.target.value }) }} /></label>
          </div>

          <div className="cr-block">
            <div className="cr-label">Columns <span className="tiny muted">click to add or remove</span></div>
            <div className="cr-chips">
              {(src?.fields || []).map((f) => {
                const on = columns.includes(f.key)
                return (
                  <button key={f.key} type="button" className={`cr-chip ${on ? 'on' : ''}`}
                    onClick={() => set({ columns: on ? columns.filter((c) => c !== f.key) : [...columns, f.key] })}>
                    {on ? '✓ ' : '+ '}{f.label}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="cr-block">
            <div className="cr-label">Filters</div>
            {cfg.filters.map((f, i) => {
              const fd = fieldMap[f.field]
              return (
                <div key={i} className="cr-filter">
                  <select value={f.field} onChange={(e) => {
                    const nf = fieldMap[e.target.value]
                    set({ filters: cfg.filters.map((x, j) => (j === i ? { field: e.target.value, op: OPS[nf.type][0][0], value: '' } : x)) })
                  }}>
                    {(src?.fields || []).map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
                  </select>
                  <select value={f.op} onChange={(e) => set({ filters: cfg.filters.map((x, j) => (j === i ? { ...x, op: e.target.value } : x)) })}>
                    {(OPS[fd?.type] || OPS.text).map(([k, t]) => <option key={k} value={k}>{t}</option>)}
                  </select>
                  {filterValue(f, i)}
                  <button type="button" className="btn btn-sm" title="Remove filter" onClick={() => set({ filters: cfg.filters.filter((_, j) => j !== i) })}>✕</button>
                </div>
              )
            })}
            <button type="button" className="btn btn-sm" onClick={() => {
              const first = src.fields[0]
              set({ filters: [...cfg.filters, { field: first.key, op: OPS[first.type][0][0], value: '' }] })
            }}>+ Add filter</button>
          </div>

          <div className="cr-row">
            <label>Group by
              <select value={cfg.group_by} onChange={(e) => set({ group_by: e.target.value })}>
                <option value="">No grouping (one row each)</option>
                {groupable.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
              </select>
            </label>
            {fieldMap[cfg.group_by]?.type === 'date' && (
              <label>By
                <select value={cfg.group_bucket} onChange={(e) => set({ group_bucket: e.target.value })}>
                  {BUCKETS.map(([k, t]) => <option key={k} value={k}>{t}</option>)}
                </select>
              </label>
            )}
            <label>Sort by
              <select value={cfg.sort} onChange={(e) => set({ sort: e.target.value })}>
                <option value="">(default)</option>
                {cfg.group_by && <option value="_count">Count</option>}
                {sortable.filter((c) => c.key !== '_count').map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
              </select>
            </label>
            <label>Order
              <select value={cfg.sort_dir} onChange={(e) => set({ sort_dir: e.target.value })}>
                <option value="asc">Low to high / A to Z</option>
                <option value="desc">High to low / Z to A</option>
              </select>
            </label>
          </div>

          <div className="cr-actions">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => run()}>{busy ? 'Running…' : 'Run report'}</button>
            {current?.id && current.can_change && <button type="button" className="btn" onClick={() => save(false)}>Save</button>}
            {naming === null
              ? <button type="button" className="btn" onClick={() => save(true)}>{current?.id ? 'Save as new' : 'Save report'}</button>
              : <span className="cr-name">
                  <input autoFocus placeholder="Report name" value={naming} onChange={(e) => setNaming(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') save(true); if (e.key === 'Escape') setNaming(null) }} />
                  <button type="button" className="btn btn-primary" onClick={() => save(true)}>Save</button>
                  <button type="button" className="btn" onClick={() => setNaming(null)}>Cancel</button>
                </span>}
            <span className="spacer" />
            <button type="button" className="btn" disabled={!result} onClick={exportCSV}>Export CSV</button>
            <button type="button" className="btn" disabled={!result} onClick={() => window.print()}>Print</button>
          </div>
        </div>

        <Alert>{err}</Alert>
        <Alert kind="success">{msg}</Alert>

        {result && (
          <>
            <div className="print-only print-title">{current?.name || 'Custom report'} · {fmtDate(result.start)} to {fmtDate(result.end)}</div>
            <p className="tiny muted cr-summary">
              {result.grouped ? `${result.count} group${result.count === 1 ? '' : 's'} from ${result.row_count} row${result.row_count === 1 ? '' : 's'}` : `${result.count} row${result.count === 1 ? '' : 's'}`} · {fmtDate(result.start)} to {fmtDate(result.end)}
              {result.truncated && ' · showing the first 5,000; narrow the dates or add a filter'}
            </p>
            <div className="card no-pad">
              {!result.rows.length ? <Empty>No rows for these settings.</Empty> : (
                <div className="table-wrap">
                  <table className="table">
                    <thead><tr>{result.columns.map((c) => <th key={c.key} className={c.type === 'money' || c.type === 'int' ? 'num' : ''}>{c.label}</th>)}</tr></thead>
                    <tbody>
                      {result.rows.map((row, i) => (
                        <tr key={i} className={result.ids[i] ? 'clickable' : ''} onClick={() => result.ids[i] && navigate(`/stays/${result.ids[i]}`)}>
                          {row.map((v, j) => {
                            const c = result.columns[j]
                            const n = c.type === 'money' || c.type === 'int'
                            return <td key={j} className={`${n ? 'num' : ''} ${c.key === 'balance' && num(v) > 0 ? 'owed' : ''}`}>{fmtCell(v, c.type)}</td>
                          })}
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        {result.columns.map((c, j) => {
                          const t = result.totals[c.key]
                          if (j === 0 && t === undefined) return <td key={c.key}>Total</td>
                          return <td key={c.key} className={t !== undefined ? 'num' : ''}>{t === undefined ? '' : c.type === 'money' ? money(t) : t}</td>
                        })}
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
        {!result && !busy && <div className="card"><Empty>Pick a ready-made report on the left, or choose your data, columns and filters, then press Run report.</Empty></div>}
      </section>
    </div>
  )
}
