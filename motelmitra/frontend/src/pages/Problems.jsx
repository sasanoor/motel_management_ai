import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import api, { errorText } from '../api'
import { useAuth } from '../auth'
import { confirmBox } from '../confirm'
import { AuthImage } from '../components/Photos'
import ProblemForm, { PhotoPick } from '../components/ProblemForm'
import { CATEGORIES, uploadIssuePhotos } from '../problems'
import { Alert, Empty, HkPill, Modal, PageHead } from '../components/ui'
import { fmtDateTime } from '../utils'

const STATUS_OPTS = [['active', 'Not fixed yet'], ['OPEN', 'Open'], ['IN_PROGRESS', 'In progress'], ['FIXED', 'Fixed'], ['all', 'All']]
const ST_PILL = { OPEN: 'pill-red', IN_PROGRESS: 'pill-blue', FIXED: 'pill-green' }
const PR_PILL = { LOW: 'pill-grey', NORMAL: 'pill-warn', URGENT: 'pill-red' }

/** Mark fixed (or add a note / photos): note, and put an out-of-order room back to Ready. */
function UpdateBox({ issue, mode, onClose, onDone }) {
  const fixing = mode === 'fix'
  const [note, setNote] = useState('')
  const [ready, setReady] = useState(issue.room_status === 'OUT_OF_ORDER')
  const [files, setFiles] = useState([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  async function save(e) {
    e.preventDefault()
    if (!fixing && !note.trim() && !files.length) { setErr('Write a note or add a photo.'); return }
    setBusy(true); setErr('')
    try {
      if (fixing || note.trim()) {
        await api.patch(`/room-problems/${issue.id}/`, { ...(fixing ? { status: 'FIXED' } : {}), note: note.trim() })
      }
      const failed = await uploadIssuePhotos(issue.id, files)
      if (fixing && ready) await api.post(`/housekeeping/rooms/${issue.room}/status/`, { status: 'READY', note: `Fixed: ${issue.category_label}` })
      onDone(failed)
    } catch (e2) { setErr(errorText(e2)); setBusy(false) }
  }
  return (
    <Modal title={`${fixing ? 'Mark fixed' : 'Add note'} · Room ${issue.room_number}`} onClose={busy ? () => {} : onClose} width={460}>
      <form onSubmit={save} className="form-grid">
        <Alert>{err}</Alert>
        <div className="muted">{issue.category_label}: {issue.description}</div>
        <label className="field">
          <span className="field-label">{fixing ? 'What was done? (optional)' : 'Note'}</span>
          <textarea rows={2} maxLength={255} autoFocus value={note} onChange={(e) => setNote(e.target.value)}
            placeholder={fixing ? 'e.g. Replaced the tap washer' : 'e.g. Plumber coming tomorrow 10 AM'} />
        </label>
        <PhotoPick files={files} setFiles={setFiles} max={10 - issue.photos.length} />
        {fixing && issue.room_status === 'OUT_OF_ORDER' && (
          <label className="check-line">
            <input type="checkbox" checked={ready} onChange={(e) => setReady(e.target.checked)} />
            <span>Room {issue.room_number} is out of order. <strong>Put it back to Ready</strong> so it can be rented.</span>
          </label>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : fixing ? '✓ Mark fixed' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  )
}

function ProblemCard({ p, isAdmin, onStatus, onBox, onDelete }) {
  const [showHist, setShowHist] = useState(false)
  return (
    <div className={`pb-card ${p.status === 'FIXED' ? 'FIXED' : p.priority}`}>
      <div className="pb-top">
        <span className="room-chip">{p.room_number}</span>
        <strong>{p.category_label}</strong>
        <span className={`pill ${PR_PILL[p.priority]}`}>{p.priority_label}</span>
        <span className={`pill ${ST_PILL[p.status]}`}>{p.status_label}</span>
        <HkPill status={p.room_status} />
        <span className="tiny muted" style={{ marginLeft: 'auto' }}>#{p.id} · {p.reported_by_name} · {fmtDateTime(p.created_at)}</span>
      </div>
      <div className="pb-desc">{p.description}</div>
      {p.photos.length > 0 && (
        <div className="pb-photos">
          {p.photos.map((ph) => <AuthImage key={ph.id} photo={{ ...ph, kind_label: `Room ${p.room_number} problem`, created_at: p.created_at }} />)}
        </div>
      )}
      {p.status === 'FIXED' && <div className="tiny muted">Fixed by {p.fixed_by_name} · {fmtDateTime(p.fixed_at)}</div>}
      <div className="hk-actions" style={{ marginTop: 8 }}>
        {p.status === 'OPEN' && <button className="btn btn-sm" onClick={() => onStatus(p, 'IN_PROGRESS')}>Start work</button>}
        {p.status !== 'FIXED' && <button className="btn btn-sm btn-primary" onClick={() => onBox(p, 'fix')}>✓ Fixed</button>}
        {p.status !== 'FIXED' && <button className="btn btn-sm" onClick={() => onBox(p, 'note')}>Add note / photo</button>}
        {p.status === 'FIXED' && <button className="btn btn-sm" onClick={() => onStatus(p, 'OPEN')}>Reopen</button>}
        <button type="button" className="link-btn" style={{ alignSelf: 'center' }} onClick={() => setShowHist((v) => !v)}>
          {showHist ? 'Hide history' : `History (${p.history.length})`}
        </button>
        {isAdmin && <button type="button" className="link-btn danger" style={{ alignSelf: 'center' }} onClick={() => onDelete(p)}>Delete</button>}
      </div>
      {showHist && (
        <div className="pb-history">
          {p.history.map((h, i) => <div key={i}>{fmtDateTime(h.at)} · <strong>{h.by}</strong> · {h.note}</div>)}
        </div>
      )}
    </div>
  )
}

/** Room problems: anyone reports, anyone marks fixed. Admin can delete. */
export default function Problems() {
  const { user } = useAuth()
  const [params, setParams] = useSearchParams()
  const [filters, setFilters] = useState({ status: 'active', room: params.get('room') || '', category: '' })
  const [list, setList] = useState(null)
  const [rooms, setRooms] = useState([])
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  const [adding, setAdding] = useState(params.get('new') === '1')
  const [box, setBox] = useState(null)

  const load = useCallback(() => api.get('/room-problems/', { params: filters })
    .then((r) => { setList(r.data.results || r.data); setErr('') })
    .catch((e) => setErr(errorText(e))), [filters])

  useEffect(() => { load() }, [load])
  useEffect(() => { api.get('/housekeeping/').then((r) => setRooms(r.data.rooms)).catch(() => {}) }, [])

  const setF = (k, v) => {
    setFilters((o) => ({ ...o, [k]: v }))
    if (k === 'room') setParams(v ? { room: v } : {}, { replace: true })
  }

  async function changeStatus(p, st) {
    setErr(''); setMsg('')
    try { await api.patch(`/room-problems/${p.id}/`, { status: st }); load() } catch (e) { setErr(errorText(e)) }
  }

  async function remove(p) {
    const ok = await confirmBox({ title: 'Delete this problem?', message: 'It is removed for good, with its photos. To close it normally, use Fixed.',
      details: [['Room', p.room_number], ['Problem', `${p.category_label}: ${p.description.slice(0, 60)}`]] })
    if (!ok) return
    try { await api.delete(`/room-problems/${p.id}/`); load() } catch (e) { setErr(errorText(e)) }
  }

  return (
    <>
      <PageHead title="Room problems" sub="Anything broken or wrong in a room. Everyone can report and mark fixed.">
        <button className="btn btn-warn" onClick={() => setAdding(true)}>⚠ Report problem</button>
      </PageHead>
      <Alert>{err}</Alert>
      <Alert kind="success">{msg}</Alert>

      <div className="filters">
        <select value={filters.status} onChange={(e) => setF('status', e.target.value)}>
          {STATUS_OPTS.map(([k, t]) => <option key={k} value={k}>{t}</option>)}
        </select>
        <select value={filters.room} onChange={(e) => setF('room', e.target.value)}>
          <option value="">All rooms</option>
          {rooms.map((r) => <option key={r.id} value={r.id}>Room {r.number}</option>)}
        </select>
        <select value={filters.category} onChange={(e) => setF('category', e.target.value)}>
          <option value="">All types</option>
          {CATEGORIES.map(([k, t]) => <option key={k} value={k}>{t}</option>)}
        </select>
        {list && <span className="tiny muted">{list.length} problem{list.length === 1 ? '' : 's'}</span>}
      </div>

      {list && (list.length ? (
        <div className="pb-list">
          {list.map((p) => (
            <ProblemCard key={p.id} p={p} isAdmin={user.role === 'CLIENT_ADMIN'} onStatus={changeStatus}
              onBox={(x, mode) => setBox({ issue: x, mode })} onDelete={remove} />
          ))}
        </div>
      ) : <div className="card"><Empty>{filters.status === 'active' ? 'No open problems. 🎉' : 'No problems match.'}</Empty></div>)}

      {adding && (
        <ProblemForm rooms={rooms} roomId={filters.room} onClose={() => setAdding(false)}
          onSaved={(p, failed) => {
            setAdding(false)
            setMsg(`Problem reported for room ${p.room_number}.${failed ? ` ${failed} photo(s) did not upload.` : ''}`)
            load()
          }} />
      )}
      {box && (
        <UpdateBox issue={box.issue} mode={box.mode} onClose={() => setBox(null)}
          onDone={(failed) => {
            setBox(null)
            setMsg(`${box.mode === 'fix' ? 'Marked fixed' : 'Saved'}: room ${box.issue.room_number}.${failed ? ` ${failed} photo(s) did not upload.` : ''}`)
            load()
          }} />
      )}
    </>
  )
}
