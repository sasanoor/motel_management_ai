import { useCallback, useEffect, useState } from 'react'
import api, { errorText } from '../api'
import { useAuth } from '../auth'
import { confirmBox } from '../confirm'
import GridFilter from '../components/GridFilter'
import { Alert, Empty, Modal, PageHead, Stat } from '../components/ui'
import { addDays, fmtDate, fmtDateTime, money, num, todayISO } from '../utils'

const qty = (v) => {
  const n = num(v)
  return Number.isInteger(n) ? String(n) : n.toFixed(2)
}
const KIND_PILL = { IN: 'pill-green', OUT: 'pill-warn', ADJUST: 'pill-blue' }
const CATEGORIES = ['Linen', 'Bathroom', 'Cleaning', 'Room', 'Breakfast', 'Office', 'Maintenance']

/**
 * Supplies the motel keeps: how many are in stock, stock in, taken out, low stock alert.
 * Maintenance staff (phone) see "Supplies" and can only take items out.
 */
export default function Inventory() {
  const { user, isAdmin } = useAuth()
  const maint = user.role === 'MAINTENANCE'
  const [tab, setTab] = useState('stock')
  const [items, setItems] = useState(null)
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  const [move, setMove] = useState(null)      // { item, kind }
  const [editing, setEditing] = useState(null) // item or {} for new
  const [lowOnly, setLowOnly] = useState(false)

  const load = useCallback(() => {
    api.get('/inventory/items/').then((r) => setItems(r.data)).catch((e) => setErr(errorText(e)))
  }, [])
  useEffect(() => { load() }, [load])

  const done = (text) => { setMsg(text); setErr(''); setMove(null); setEditing(null); load() }

  async function remove(it) {
    const ok = await confirmBox({
      title: `Stop tracking ${it.name}?`,
      message: 'The item leaves the list. Its stock history stays in History. Add it again with the same name to bring it back.',
      confirmText: 'Remove item',
    })
    if (!ok) return
    try { await api.delete(`/inventory/items/${it.id}/`); done(`${it.name} removed from the list.`) } catch (e) { setErr(errorText(e)) }
  }

  const list = items || []
  const low = list.filter((i) => i.is_low)
  const shown = lowOnly ? low : list

  return (
    <>
      <PageHead title={maint ? 'Supplies' : 'Inventory'} sub={maint ? 'Take out what you use: the count goes down' : 'Supplies in stock, stock in and taken out'}>
        {!maint && <button className="btn btn-primary" onClick={() => setEditing({})}>+ Add item</button>}
      </PageHead>
      <Alert>{err}</Alert>
      <Alert kind="success">{msg}</Alert>

      {low.length > 0 && (
        <div className="alert low-stock-banner">
          <strong>Low stock: {low.length} item{low.length > 1 ? 's' : ''}.</strong>{' '}
          {low.slice(0, 6).map((i) => `${i.name} (${qty(i.quantity)} ${i.unit})`).join(', ')}{low.length > 6 ? '…' : '.'}
          {!maint && ' Order more and record it with Stock in.'}
        </div>
      )}

      {!maint && (
        <div className="tabs">
          <button className={tab === 'stock' ? 'on' : ''} onClick={() => setTab('stock')}>Stock</button>
          <button className={tab === 'history' ? 'on' : ''} onClick={() => setTab('history')}>History</button>
        </div>
      )}

      {tab === 'history' ? <History items={list} /> : <>
        <div className="stats">
          <Stat label="Items" value={list.length} onClick={() => setLowOnly(false)} />
          <Stat label="Low stock" value={low.length} tone={low.length ? 'bad' : 'good'} onClick={() => setLowOnly(true)} />
        </div>
        {lowOnly && <p className="tiny">Showing low stock only · <button className="link-btn" onClick={() => setLowOnly(false)}>Show all</button></p>}

        {items && !list.length ? (
          <Empty>No items yet.{!maint && ' Add the supplies you keep: towels, soap, toilet paper, sheets…'}</Empty>
        ) : maint ? (
          <div className="supply-cards">
            {shown.map((it) => (
              <div key={it.id} className={`supply-card ${it.is_low ? 'is-low' : ''}`}>
                <div>
                  <strong>{it.name}</strong>
                  <span className="tiny muted">{it.category}</span>
                </div>
                <div className="supply-qty">{qty(it.quantity)} <span className="tiny">{it.unit}</span>{it.is_low && <span className="pill pill-red">Low</span>}</div>
                <button className="btn btn-primary" disabled={num(it.quantity) <= 0} onClick={() => setMove({ item: it, kind: 'OUT' })}>Take out</button>
              </div>
            ))}
          </div>
        ) : (
          <div className="table-wrap"><GridFilter placeholder="Filter items…" />
            <table className="table">
              <thead><tr><th>Item</th><th>Category</th><th className="num">In stock</th><th className="num">Alert at</th><th>Last change</th><th></th></tr></thead>
              <tbody>
                {shown.map((it) => (
                  <tr key={it.id} className={it.is_low ? 'low-row' : ''}>
                    <td><strong>{it.name}</strong></td>
                    <td>{it.category || '—'}</td>
                    <td className="num"><strong>{qty(it.quantity)}</strong> {it.unit} {it.is_low && <span className="pill pill-red">Low</span>}</td>
                    <td className="num muted">{num(it.min_quantity) > 0 ? `${qty(it.min_quantity)} ${it.unit}` : '—'}</td>
                    <td className="tiny muted">{it.last_move_at ? fmtDateTime(it.last_move_at) : '—'}</td>
                    <td className="row-actions">
                      <button className="btn btn-sm btn-add" onClick={() => setMove({ item: it, kind: 'IN' })}>Stock in</button>
                      <button className="btn btn-sm" disabled={num(it.quantity) <= 0} onClick={() => setMove({ item: it, kind: 'OUT' })}>Take out</button>
                      {isAdmin && <button className="btn btn-sm" onClick={() => setMove({ item: it, kind: 'ADJUST' })}>Correct count</button>}
                      <button className="btn btn-sm" onClick={() => setEditing(it)}>Edit</button>
                      <button className="btn btn-sm btn-danger-outline" onClick={() => remove(it)}>Remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </>}

      {move && <MoveModal item={move.item} kind={move.kind} onClose={() => setMove(null)} onDone={done} />}
      {editing && <ItemModal item={editing} onClose={() => setEditing(null)} onDone={done} />}
    </>
  )
}

function MoveModal({ item, kind, onClose, onDone }) {
  const [f, setF] = useState({ quantity: kind === 'ADJUST' ? qty(item.quantity) : '', note: '', room: '', cost: '' })
  const [rooms, setRooms] = useState([])
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (kind === 'OUT') api.get('/housekeeping/').then((r) => setRooms(r.data.rooms || [])).catch(() => {})
  }, [kind])
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value })
  const title = { IN: 'Stock in', OUT: 'Take out', ADJUST: 'Correct count' }[kind]
  const after = kind === 'IN' ? num(item.quantity) + num(f.quantity)
    : kind === 'OUT' ? num(item.quantity) - num(f.quantity) : num(f.quantity)

  async function save(e) {
    e.preventDefault()
    setBusy(true); setErr('')
    try {
      await api.post(`/inventory/items/${item.id}/move/`, { kind, ...f })
      const n = qty(f.quantity)
      onDone(kind === 'IN' ? `${n} ${item.unit} of ${item.name} added.` : kind === 'OUT' ? `${n} ${item.unit} of ${item.name} taken out.` : `${item.name} count set to ${n}.`)
    } catch (e2) { setErr(errorText(e2)); setBusy(false) }
  }
  return (
    <Modal title={`${title} · ${item.name}`} onClose={onClose} width={480}>
      <Alert>{err}</Alert>
      <form onSubmit={save} className="form-grid cols-2">
        <label>{kind === 'ADJUST' ? 'Counted quantity' : 'Quantity'} ({item.unit})
          <input type="number" step="any" min={kind === 'ADJUST' ? 0 : 0.01} max={kind === 'OUT' ? num(item.quantity) : undefined}
            inputMode="decimal" value={f.quantity} onChange={set('quantity')} required autoFocus />
        </label>
        <div className="readout">
          <span>In stock now → after</span>
          <strong>{qty(item.quantity)} → <span className={after < 0 ? 'neg' : ''}>{qty(after)}</span> {item.unit}</strong>
        </div>
        {kind === 'OUT' && (
          <label>For room <span className="tiny muted">(optional)</span>
            <select value={f.room} onChange={set('room')}>
              <option value="">General use</option>
              {rooms.map((r) => <option key={r.id} value={r.id}>Room {r.number}</option>)}
            </select>
          </label>
        )}
        {kind === 'IN' && (
          <label>Cost <span className="tiny muted">(optional, total paid)</span>
            <input type="number" step="0.01" min="0" value={f.cost} onChange={set('cost')} placeholder="0.00" />
          </label>
        )}
        <label className={kind === 'ADJUST' ? 'span-2' : ''}>Note
          <input value={f.note} onChange={set('note')} placeholder={kind === 'IN' ? 'e.g. Walmart order' : kind === 'ADJUST' ? 'e.g. Monthly count' : 'e.g. Daily cleaning'} />
        </label>
        <div className="span-2 form-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : title}</button>
        </div>
      </form>
    </Modal>
  )
}

function ItemModal({ item, onClose, onDone }) {
  const isNew = !item.id
  const [f, setF] = useState({
    name: item.name || '', category: item.category || '', unit: item.unit || 'pcs',
    quantity: isNew ? '' : qty(item.quantity), min_quantity: item.id ? qty(item.min_quantity) : '',
  })
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value })
  async function save(e) {
    e.preventDefault()
    setBusy(true); setErr('')
    const body = { name: f.name, category: f.category, unit: f.unit || 'pcs', min_quantity: num(f.min_quantity).toFixed(2) }
    try {
      if (isNew) await api.post('/inventory/items/', { ...body, quantity: num(f.quantity).toFixed(2) })
      else await api.patch(`/inventory/items/${item.id}/`, body)
      onDone(isNew ? `${f.name} added.` : `${f.name} saved.`)
    } catch (e2) { setErr(errorText(e2)); setBusy(false) }
  }
  return (
    <Modal title={isNew ? 'Add item' : `Edit ${item.name}`} onClose={onClose} width={520}>
      <Alert>{err}</Alert>
      <form onSubmit={save} className="form-grid cols-2">
        <label className="span-2">Item name
          <input value={f.name} onChange={set('name')} required autoFocus placeholder="e.g. Bath towel" />
        </label>
        <label>Category
          <input value={f.category} onChange={set('category')} list="inv-cats" placeholder="e.g. Linen" />
          <datalist id="inv-cats">{CATEGORIES.map((c) => <option key={c} value={c} />)}</datalist>
        </label>
        <label>Unit
          <input value={f.unit} onChange={set('unit')} list="inv-units" placeholder="pcs" />
          <datalist id="inv-units">{['pcs', 'rolls', 'boxes', 'packs', 'bottles', 'sets', 'gallons'].map((c) => <option key={c} value={c} />)}</datalist>
        </label>
        {isNew ? (
          <label>In stock now
            <input type="number" step="any" min="0" value={f.quantity} onChange={set('quantity')} placeholder="0" />
          </label>
        ) : (
          <div className="readout"><span>In stock</span><strong>{qty(item.quantity)} {item.unit}</strong><span className="tiny muted">Change with Stock in, Take out or Correct count</span></div>
        )}
        <label>Low stock alert at
          <input type="number" step="any" min="0" value={f.min_quantity} onChange={set('min_quantity')} placeholder="0 = no alert" />
          <span className="hint">Alert when the count is this or less</span>
        </label>
        <div className="span-2 form-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  )
}

function History({ items }) {
  const [p, setP] = useState({ start: addDays(todayISO(), -30), end: todayISO(), item: '', kind: '' })
  const [rows, setRows] = useState(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    const params = Object.fromEntries(Object.entries(p).filter(([, v]) => v))
    api.get('/inventory/moves/', { params }).then((r) => { setRows(r.data); setErr('') }).catch((e) => setErr(errorText(e)))
  }, [p])
  const set = (k) => (e) => setP({ ...p, [k]: e.target.value })
  const spent = (rows || []).reduce((a, r) => a + num(r.cost), 0)
  return (
    <>
      <Alert>{err}</Alert>
      <div className="filters">
        <label className="inline">From <input type="date" value={p.start} onChange={set('start')} /></label>
        <label className="inline">To <input type="date" value={p.end} onChange={set('end')} /></label>
        <select value={p.item} onChange={set('item')}>
          <option value="">All items</option>
          {items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
        </select>
        <select value={p.kind} onChange={set('kind')}>
          <option value="">All changes</option>
          <option value="IN">Stock in</option>
          <option value="OUT">Taken out</option>
          <option value="ADJUST">Count corrected</option>
        </select>
        {spent > 0 && <span className="muted">Spent on stock in: <strong>{money(spent)}</strong></span>}
      </div>
      {rows && !rows.length ? <Empty>No stock changes in these dates.</Empty> : (
        <div className="table-wrap"><GridFilter />
          <table className="table">
            <thead><tr><th>Business day</th><th>When</th><th>Item</th><th>Change</th><th className="num">Qty</th><th className="num">Stock after</th><th>Room</th><th className="num">Cost</th><th>By</th><th>Note</th></tr></thead>
            <tbody>
              {(rows || []).map((r) => (
                <tr key={r.id}>
                  <td>{fmtDate(r.business_date)}</td>
                  <td className="tiny muted">{fmtDateTime(r.created_at)}</td>
                  <td><strong>{r.item_name}</strong></td>
                  <td><span className={`pill ${KIND_PILL[r.kind]}`}>{r.kind_label}</span></td>
                  <td className={`num ${num(r.change) < 0 ? 'neg' : ''}`}>{num(r.change) > 0 ? '+' : ''}{qty(r.change)} {r.unit}</td>
                  <td className="num">{qty(r.balance_after)}</td>
                  <td>{r.room_number || '—'}</td>
                  <td className="num">{r.cost ? money(r.cost) : '—'}</td>
                  <td>{r.user_name}</td>
                  <td className="muted">{r.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
