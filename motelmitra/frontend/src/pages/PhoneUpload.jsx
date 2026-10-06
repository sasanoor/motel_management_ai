import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { compressImage } from '../photoUtils'

/**
 * Opened on a phone from the QR code (no login). Takes photos with the phone camera
 * and sends them straight to the check-in / checkout open on the PC.
 */
export default function PhoneUpload() {
  const { token } = useParams()
  const [info, setInfo] = useState(null)
  const [err, setErr] = useState('')
  const [sent, setSent] = useState([])     // [{ kind, url }]
  const [busy, setBusy] = useState('')
  const inputs = { DL_FRONT: useRef(null), DL_BACK: useRef(null), DAMAGE: useRef(null) }

  useEffect(() => {
    fetch(`/api/phone/${token}/`).then(async (r) => {
      const d = await r.json()
      if (!r.ok) throw new Error(d.detail || 'This link does not work.')
      setInfo(d)
    }).catch((e) => setErr(e.message))
  }, [token])

  async function send(kind, file) {
    if (!file) return
    setBusy(kind); setErr('')
    try {
      const blob = await compressImage(file)
      const fd = new FormData()
      fd.append('image', blob, 'photo.jpg')
      fd.append('kind', kind)
      const r = await fetch(`/api/phone/${token}/upload/`, { method: 'POST', body: fd })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d.detail || d.image || 'Upload failed. Try again.')
      setSent((s) => [...s.filter((x) => kind === 'DAMAGE' || x.kind !== kind), { kind, url: URL.createObjectURL(blob) }])
    } catch (e) { setErr(e.message) }
    setBusy('')
  }

  const isDl = info && info.kind !== 'DAMAGE'
  const has = (k) => sent.some((x) => x.kind === k)
  const btn = (kind, label) => (
    <>
      <button className={`phone-btn ${has(kind) && kind !== 'DAMAGE' ? 'done' : ''}`} disabled={!!busy}
        onClick={() => inputs[kind].current?.click()}>
        {busy === kind ? 'Sending…' : has(kind) && kind !== 'DAMAGE' ? `✓ ${label} sent · tap to retake` : `📷 Take ${label}`}
      </button>
      <input ref={inputs[kind]} type="file" accept="image/*" capture="environment" hidden
        onChange={(e) => { const f = e.target.files[0]; e.target.value = ''; send(kind, f) }} />
    </>
  )

  return (
    <div className="phone-page">
      <div className="phone-head">
        <span className="brand-mark">M</span>
        <div>
          <strong>MotelMitra</strong>
          <div className="tiny">{info?.motel || ''}</div>
        </div>
      </div>
      {err && <div className="alert alert-error">{err}</div>}
      {info && (
        <>
          <h1>{isDl ? 'Driving licence photo' : `Room ${info.room}: damage photos`}</h1>
          <p className="muted">{isDl ? 'Take the front, then the back. Fill the frame, avoid glare.' : 'Take as many photos as you need.'}</p>
          {isDl ? <>{btn('DL_FRONT', 'DL front')}{btn('DL_BACK', 'DL back')}</> : btn('DAMAGE', sent.length ? 'another photo' : 'photo')}
          {sent.length > 0 && (
            <>
              <div className="phone-thumbs">
                {sent.map((x, i) => <img key={i} src={x.url} alt={x.kind} />)}
              </div>
              <div className="alert alert-success">✓ {sent.length} photo{sent.length > 1 ? 's' : ''} sent to the front desk PC.{isDl && has('DL_FRONT') && has('DL_BACK') ? ' You can close this page.' : ''}</div>
            </>
          )}
        </>
      )}
    </div>
  )
}
