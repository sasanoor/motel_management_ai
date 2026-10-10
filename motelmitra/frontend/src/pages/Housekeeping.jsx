import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import api, { errorText } from '../api'
import { useAuth } from '../auth'
import ProblemForm from '../components/ProblemForm'
import { Alert, Empty, HkPill, IssueBadge, Modal, PageHead, Stat } from '../components/ui'
import { fmtDate, fmtDateTime } from '../utils'
import GridFilter from '../components/GridFilter'

const toClean = (r) => r.occupancy === 'vacant' && (r.hk_status === 'DIRTY' || r.hk_status === 'CLEANING')
const notOut = (r) => r.occupancy === 'due_out'
// Checkouts = rooms to clean (guest left) + rooms whose guest has not checked out yet today
const TABS = [
  ['checkouts', 'Checkouts', (r) => toClean(r) || notOut(r)],
  ['service', 'Stay-over service', (r) => !!r.service],
  ['ooo', 'Out of order', (r) => r.hk_status === 'OUT_OF_ORDER'],
  ['ready', 'Ready', (r) => r.occupancy === 'vacant' && r.hk_status === 'READY'],
  ['all', 'All rooms', () => true],
]
const OCC = { vacant: ['Vacant', 'pill-grey'], in_house: ['Guest in', 'pill-blue'], due_out: ['Not checked out yet', 'pill-warn'] }
const SUB = [['all', 'All'], ['clean', 'Ready to clean'], ['notout', 'Not checked out yet']]
const ORDER = { DIRTY: 0, CLEANING: 1 }
const SVC = { NEEDED: ['Service needed', 'pill-warn'], DONE: ['Serviced', 'pill-green'], DECLINED: ['Guest declined', 'pill-grey'] }

function OutOfOrderBox({ room, onClose, onSave }) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  async function save(e) {
    e.preventDefault()
    if (!note.trim()) { setErr('Say why the room is out of order.'); return }
    setBusy(true)
    try { await onSave(note.trim()) } catch (e2) { setErr(errorText(e2)); setBusy(false) }
  }
  return (
    <Modal title={`Room ${room.number}: out of order`} onClose={onClose} width={440}>
      <form onSubmit={save} className="form-grid">
        <Alert>{err}</Alert>
        <p className="muted" style={{ margin: 0 }}>The room cannot be rented until someone puts it back in service.</p>
        <label className="field">
          <span className="field-label">Reason</span>
          <input autoFocus maxLength={255} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. AC not working, waiting for parts" />
        </label>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>Put out of order</button>
        </div>
      </form>
    </Modal>
  )
}

function RoomCard({ r, staff, act, onOoo, onProblem }) {
  const vacant = r.occupancy === 'vacant'
  const ooo = r.hk_status === 'OUT_OF_ORDER'
  const [occ, occCls] = OCC[r.occupancy]
  return (
    <div className={`hk-card ${r.occupancy === 'due_out' && r.hk_status !== 'OUT_OF_ORDER' ? 'DUEOUT' : r.hk_status}`}>
      <div className="mt-head">
        <div>
          <div className="mt-room">{r.number}</div>
          <div className="tiny muted">{r.room_type}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <HkPill status={r.hk_status} note={r.hk_note} showReady={r.occupancy === 'vacant'} />
          <IssueBadge count={r.open_issues} />
          <div style={{ marginTop: 4 }}><span className={`pill ${occCls}`}>{occ}</span></div>
        </div>
      </div>

      {staff && r.guest_name && (
        <div className="hk-meta">{r.guest_name}{r.check_out_date && ` · out ${fmtDate(r.check_out_date)}`}</div>
      )}
      {r.hk_note && (ooo || r.hk_status === 'DIRTY') && <div className="hk-note">{r.hk_note}</div>}
      {r.hk_updated_by && <div className="hk-meta">{r.hk_updated_by} · {fmtDateTime(r.hk_updated_at)}</div>}

      {r.service && (
        <div className="hk-svc">
          <span className={`pill ${SVC[r.service][1]}`}>{SVC[r.service][0]}</span>
          {r.service !== 'NEEDED' && <span className="tiny muted">{r.service_by} · {fmtDateTime(r.service_at)}</span>}
        </div>
      )}

      <div className="hk-actions">
        {r.service === 'NEEDED' && <>
          <button className="btn btn-primary" onClick={() => act('service', r, 'DONE')}>✓ Service done</button>
          <button className="btn" onClick={() => act('service', r, 'DECLINED')}>Guest said no</button>
        </>}
        {r.service && r.service !== 'NEEDED' && <button className="btn btn-sm" onClick={() => act('unservice', r)}>Undo</button>}

        {ooo ? (
          <button className="btn btn-primary" onClick={() => act('status', r, 'READY')}>Back in service</button>
        ) : vacant && <>
          {r.hk_status === 'DIRTY' && <button className="btn" onClick={() => act('status', r, 'CLEANING')}>Start cleaning</button>}
          {r.hk_status !== 'READY' && <button className="btn btn-primary" onClick={() => act('status', r, 'READY')}>✓ Clean &amp; ready</button>}
          {r.hk_status === 'READY' && <button className="btn" onClick={() => act('status', r, 'DIRTY')}>Mark dirty</button>}
          {r.hk_status === 'CLEANING' && <button className="btn btn-sm" onClick={() => act('status', r, 'DIRTY')}>Back to dirty</button>}
        </>}
      </div>
      <div className="hk-actions">
        <button className="btn btn-sm" onClick={() => onProblem(r)}>⚠ Report problem</button>
        {!ooo && r.occupancy !== 'in_house' && <button className="btn btn-sm btn-danger-outline" onClick={() => onOoo(r)}>Out of order</button>}
      </div>
    </div>
  )
}

/** Housekeeping board: room status (Ready / Dirty / Cleaning / Out of order) and stay-over service. */
export default function Housekeeping() {
  const { user } = useAuth()
  const staff = user.role !== 'MAINTENANCE'
  const [data, setData] = useState(null)
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  const [tab, setTab] = useState(null)
  const [q, setQ] = useState('')
  const [sub, setSub] = useState('all')   // Checkouts tab: all / ready to clean / not checked out yet
  const [ooo, setOoo] = useState(null)
  const [problem, setProblem] = useState(null)

  const load = useCallback(() => api.get('/housekeeping/')
    .then((r) => { setData(r.data); setErr('') })
    .catch((e) => setErr(errorText(e))), [])

  useEffect(() => {
    load()
    const t = setInterval(load, 60000)
    return () => clearInterval(t)
  }, [load])

  const rooms = data?.rooms || []
  const counts = Object.fromEntries(TABS.map(([k, , fn]) => [k, rooms.filter(fn).length]))
  const current = tab || (counts.checkouts ? 'checkouts' : counts.service ? 'service' : 'all')
  const fn = TABS.find((t) => t[0] === current)[2]
  const subCount = { all: counts.checkouts, clean: rooms.filter(toClean).length, notout: rooms.filter(notOut).length }
  let shown = rooms.filter(fn).filter((r) => !q.trim() || r.number.toLowerCase().includes(q.trim().toLowerCase()))
  if (current === 'checkouts') {
    if (sub === 'clean') shown = shown.filter(toClean)
    if (sub === 'notout') shown = shown.filter(notOut)
    // dirty first, then being cleaned, then guests still in the room
    shown = [...shown].sort((a, b) => (notOut(a) ? 2 : ORDER[a.hk_status] ?? 1) - (notOut(b) ? 2 : ORDER[b.hk_status] ?? 1))
  }

  async function act(kind, r, value) {
    setErr(''); setMsg('')
    try {
      if (kind === 'status') await api.post(`/housekeeping/rooms/${r.id}/status/`, { status: value })
      else if (kind === 'service') await api.post(`/housekeeping/rooms/${r.id}/service/`, { status: value })
      else if (kind === 'unservice') await api.delete(`/housekeeping/rooms/${r.id}/service/`)
      await load()
    } catch (e) { setErr(errorText(e)) }
  }

  const s = data?.summary
  return (
    <>
      <PageHead title="Housekeeping" sub={data ? `Business day ${fmtDate(data.date)}` : ''}>
        <button className="btn btn-warn" onClick={() => setProblem({})}>⚠ Report problem</button>
        <Link className="btn" to="/problems">Room problems{s?.open_issues ? ` (${s.open_issues})` : ''}</Link>
        <button className="btn" onClick={load}>Refresh</button>
      </PageHead>
      <Alert>{err}</Alert>
      <Alert kind="success">{msg}</Alert>
      {s?.low_stock > 0 && (
        <div className="alert low-stock-banner">
          <strong>Low stock:</strong> {s.low_stock} suppl{s.low_stock > 1 ? 'ies are' : 'y is'} running out. Tell the front desk.
          <Link to="/inventory">See supplies →</Link>
        </div>
      )}

      {s && (
        <div className="stats">
          <Stat label="Checkouts to clean" value={s.dirty + s.cleaning} tone={s.dirty ? 'warn' : ''} onClick={() => { setTab('checkouts'); setSub('clean') }} />
          <Stat label="Not checked out yet" value={s.due_out} onClick={() => { setTab('checkouts'); setSub('notout') }} />
          <Stat label="Ready to rent" value={s.ready} tone="good" onClick={() => setTab('ready')} />
          <Stat label="Stay-over service left" value={s.service_needed} tone={s.service_needed ? 'warn' : ''} onClick={() => setTab('service')} />
          <Stat label="Out of order" value={s.out_of_order} onClick={() => setTab('ooo')} />
        </div>
      )}

      <div className="filters">
        <div className="hk-tabs" style={{ marginBottom: 0 }}>
          {TABS.map(([k, label]) => (
            <button key={k} className={current === k ? 'on' : ''} onClick={() => setTab(k)}>
              {label}<span className="count">{counts[k]}</span>
            </button>
          ))}
        </div>
        <input className="search" style={{ maxWidth: 140 }} placeholder="Room no." value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {current === 'checkouts' && (
        <div className="seg seg-sm hk-sub">
          {SUB.map(([k, label]) => (
            <button key={k} type="button" className={sub === k ? 'on' : ''} onClick={() => setSub(k)}>{label} ({subCount[k]})</button>
          ))}
        </div>
      )}

      {data && (shown.length ? (
        <div className="hk-grid">
          {shown.map((r) => <RoomCard key={r.id} r={r} staff={staff} act={act} onOoo={setOoo} onProblem={(x) => setProblem({ room: x.id })} />)}
        </div>
      ) : <div className="card"><Empty>{current === 'checkouts' ? (sub === 'notout' ? 'Every checkout guest has left.' : 'All checkout rooms are clean. 🎉') : 'No rooms here.'}</Empty></div>)}

      {staff && data?.log?.length > 0 && (
        <>
          <h2 className="section-title">Recent room status changes</h2>
          <div className="card no-pad">
            <div className="table-wrap"><GridFilter />
              <table className="table hk-log">
                <thead><tr><th>When</th><th>Room</th><th>Change</th><th>Note</th><th>By</th></tr></thead>
                <tbody>
                  {data.log.map((g) => (
                    <tr key={g.id}>
                      <td>{fmtDateTime(g.at)}</td>
                      <td><span className="room-chip">{g.room_number}</span></td>
                      <td>
                        {g.action === 'SERVICE' ? `Stay-over: ${g.to === 'Done' ? 'serviced' : g.to.toLowerCase()}` : `${g.from || '?'} → ${g.to}`}
                        {g.action === 'OVERRIDE' && <span className="pill pill-red ml">Rented anyway</span>}
                      </td>
                      <td className="muted">{g.note}</td>
                      <td>{g.by}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {ooo && (
        <OutOfOrderBox room={ooo} onClose={() => setOoo(null)}
          onSave={async (note) => { await api.post(`/housekeeping/rooms/${ooo.id}/status/`, { status: 'OUT_OF_ORDER', note }); setOoo(null); load() }} />
      )}
      {problem && (
        <ProblemForm rooms={rooms} roomId={problem.room} onClose={() => setProblem(null)}
          onSaved={(p, failed) => {
            setProblem(null)
            setMsg(`Problem reported for room ${p.room_number}.${failed ? ` ${failed} photo(s) did not upload.` : ''}`)
            load()
          }} />
      )}
    </>
  )
}
