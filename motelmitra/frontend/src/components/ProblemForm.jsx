import { useEffect, useRef, useState } from 'react'
import api, { errorText } from '../api'
import { CATEGORIES, PRIORITIES, uploadIssuePhotos } from '../problems'
import { Alert, Modal } from './ui'

/** Photo picker: phone opens the camera, PC opens the file box. Shows small previews. */
function Thumb({ file, onRemove }) {
  const img = useRef(null)
  useEffect(() => {
    const url = URL.createObjectURL(file)
    if (img.current) img.current.src = url
    return () => URL.revokeObjectURL(url)
  }, [file])
  return (
    <div className="thumb">
      <img ref={img} alt="" />
      <button type="button" aria-label="Remove photo" onClick={onRemove}>✕</button>
    </div>
  )
}

export function PhotoPick({ files, setFiles, max = 10 }) {
  return (
    <div>
      <label className="btn btn-sm">
        📷 Add photos
        <input type="file" accept="image/*" capture="environment" multiple hidden
          onChange={(e) => { setFiles([...files, ...Array.from(e.target.files || [])].slice(0, max)); e.target.value = '' }} />
      </label>
      <span className="tiny muted"> optional · up to {max}</span>
      {files.length > 0 && (
        <div className="pb-new-photos">
          {files.map((f, i) => <Thumb key={`${f.name}-${f.lastModified}-${i}`} file={f} onRemove={() => setFiles(files.filter((_, j) => j !== i))} />)}
        </div>
      )}
    </div>
  )
}

/**
 * Report a room problem. rooms: [{ id, number, room_type, hk_status }]. roomId: preselected room.
 */
export default function ProblemForm({ rooms, roomId, onClose, onSaved }) {
  const [f, setF] = useState({ room: roomId ? String(roomId) : '', category: 'OTHER', priority: 'NORMAL', description: '', out_of_order: false })
  const [files, setFiles] = useState([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const set = (k, v) => setF((o) => ({ ...o, [k]: v }))
  const room = rooms.find((r) => String(r.id) === f.room)

  async function save(e) {
    e.preventDefault()
    if (!f.room) { setErr('Pick the room.'); return }
    if (!f.description.trim()) { setErr('Describe the problem.'); return }
    setBusy(true); setErr('')
    try {
      const { data } = await api.post('/room-problems/', { ...f, room: Number(f.room) })
      const failed = await uploadIssuePhotos(data.id, files)
      onSaved(data, failed)
    } catch (e2) {
      setErr(errorText(e2))
      setBusy(false)
    }
  }

  return (
    <Modal title="Report a room problem" onClose={busy ? () => {} : onClose} width={520}>
      <form onSubmit={save} className="form-grid">
        <Alert>{err}</Alert>
        <div className="form-grid cols-2" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <label className="field">
            <span className="field-label">Room</span>
            <select value={f.room} onChange={(e) => set('room', e.target.value)} autoFocus={!roomId}>
              <option value="">Pick room…</option>
              {rooms.map((r) => <option key={r.id} value={r.id}>{r.number} · {r.room_type}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Type</span>
            <select value={f.category} onChange={(e) => set('category', e.target.value)}>
              {CATEGORIES.map(([k, t]) => <option key={k} value={k}>{t}</option>)}
            </select>
          </label>
        </div>
        <div className="field">
          <span className="field-label">How urgent</span>
          <div className="seg seg-sm">
            {PRIORITIES.map(([k, t]) => (
              <button type="button" key={k} className={`${f.priority === k ? 'on' : ''} ${k === 'URGENT' ? 'danger' : ''}`} onClick={() => set('priority', k)}>{t}</button>
            ))}
          </div>
        </div>
        <label className="field">
          <span className="field-label">What is wrong?</span>
          <textarea rows={3} maxLength={1000} value={f.description} onChange={(e) => set('description', e.target.value)}
            placeholder="e.g. Bathroom sink leaking under the counter" autoFocus={!!roomId} />
        </label>
        <PhotoPick files={files} setFiles={setFiles} />
        {room?.hk_status !== 'OUT_OF_ORDER' && (
          <label className="check-line">
            <input type="checkbox" checked={f.out_of_order} onChange={(e) => set('out_of_order', e.target.checked)} />
            <span><strong>Room cannot be rented</strong> · put it out of order until fixed</span>
          </label>
        )}
        <div className="btn-row" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Report problem'}</button>
        </div>
      </form>
    </Modal>
  )
}
