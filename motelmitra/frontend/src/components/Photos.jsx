import { useCallback, useEffect, useRef, useState } from 'react'
import api, { errorText } from '../api'
import { DL_SIDES, uploadPhoto } from '../photoUtils'
import { fmtDateTime, isWifiHosted } from '../utils'
import { Alert, Modal } from './ui'

/* Photos for DL (front / back) and room damage.
 * Ways to add a photo: Use phone (QR code), Webcam, Choose file, drag & drop, paste (Ctrl+V).
 * Photos are made smaller on this screen first (max 1600 px, JPG) so the PC does not fill up. */

/** Photos are private: load them with the login token, then show. Click to see full size. */
export function AuthImage({ photo, className = '', onClick }) {
  const [src, setSrc] = useState(null)
  const [big, setBig] = useState(false)
  useEffect(() => {
    let url = null
    let live = true
    api.get(photo.url.replace(/^\/api/, ''), { responseType: 'blob' })
      .then((r) => { url = URL.createObjectURL(r.data); if (live) setSrc(url) })
      .catch(() => {})
    return () => { live = false; if (url) URL.revokeObjectURL(url) }
  }, [photo.url])
  return (
    <>
      {src
        ? <img src={src} alt={photo.kind_label} className={`auth-img ${className}`} onClick={onClick || (() => setBig(true))} />
        : <div className={`auth-img loading ${className}`} />}
      {big && src && (
        <Modal title={`${photo.kind_label} · ${fmtDateTime(photo.created_at)}`} onClose={() => setBig(false)} width={980}>
          <img src={src} alt={photo.kind_label} className="photo-big" />
          <p className="tiny muted">{photo.file_name}{photo.uploaded_by_name && ` · by ${photo.uploaded_by_name}`}</p>
        </Modal>
      )}
    </>
  )
}

/**
 * Photo box with all add methods.
 *  mode="DL": two tiles (Front / Back); value = { DL_FRONT: photo|null, DL_BACK: photo|null }
 *  mode="DAMAGE": any number of tiles; value = [photo]
 * stay / guest: when known, photos are linked straight away; otherwise they wait for the form to be saved.
 */
export function PhotoUploader({ mode, value, onAdd, onRemove, stay, guest, reused, title }) {
  const [picked, setPicked] = useState(null)   // side chosen by the clerk; otherwise the first empty one
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [phone, setPhone] = useState(false)
  const [cam, setCam] = useState(false)
  const [scan, setScan] = useState(false)
  const fileRef = useRef(null)
  const isDl = mode === 'DL'
  const list = isDl ? DL_SIDES.map(([k]) => value?.[k]).filter(Boolean) : (value || [])

  const side = picked || (value?.DL_FRONT && !value?.DL_BACK ? 'DL_BACK' : 'DL_FRONT')
  const setSide = setPicked

  const kindNow = isDl ? side : 'DAMAGE'

  const send = useCallback(async (files, via) => {
    setErr(''); setBusy(true)
    try {
      for (const f of files) {
        const ph = await uploadPhoto(f, { kind: kindNow, stay, guest, via })
        onAdd(ph)
        if (isDl) { setPicked(null); break }   // one photo per side; then jump to the empty side
      }
    } catch (e) { setErr(errorText(e)) }
    setBusy(false)
  }, [kindNow, stay, guest, onAdd, isDl])

  function onDrop(e) {
    e.preventDefault()
    const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'))
    if (files.length) send(files, 'FILE')
  }
  function onPaste(e) {
    const files = [...(e.clipboardData?.items || [])].filter((i) => i.type.startsWith('image/')).map((i) => i.getAsFile())
    if (files.length) { e.preventDefault(); send(files, 'FILE') }
  }

  return (
    <div className="photo-box" tabIndex={0} onDragOver={(e) => e.preventDefault()} onDrop={onDrop} onPaste={onPaste}>
      <div className="photo-box-head">
        <strong>{title || (isDl ? 'DL photos' : 'Room damage photos')}</strong>
        {isDl && (
          <div className="seg seg-sm">
            {DL_SIDES.map(([k, label]) => (
              <button type="button" key={k} className={side === k ? 'on' : ''} onClick={() => setSide(k)}>{label}</button>
            ))}
          </div>
        )}
      </div>

      <div className="photo-tiles">
        {isDl ? DL_SIDES.map(([k, label]) => {
          const ph = value?.[k]
          const old = !ph && reused?.[k]
          return (
            <div key={k} className={`photo-tile ${side === k ? 'target' : ''}`} onClick={() => setSide(k)}>
              {ph ? (
                <>
                  <AuthImage photo={ph} />
                  <button type="button" className="tile-x" title="Remove" onClick={(e) => { e.stopPropagation(); onRemove(ph) }}>✕</button>
                </>
              ) : old ? (
                <>
                  <AuthImage photo={old} className="faded" />
                  <span className="tile-note">On file from last stay</span>
                </>
              ) : <span className="tile-empty">{label}</span>}
              <span className="tile-label">{label}</span>
            </div>
          )
        }) : (
          <>
            {list.map((ph) => (
              <div key={ph.id} className="photo-tile">
                <AuthImage photo={ph} />
                <button type="button" className="tile-x" title="Remove" onClick={() => onRemove(ph)}>✕</button>
              </div>
            ))}
            {!list.length && <span className="tile-empty wide">No photos yet</span>}
          </>
        )}
      </div>

      <div className="photo-actions">
        {isWifiHosted()
          ? <button type="button" className="btn btn-sm btn-primary" onClick={() => setPhone(true)} disabled={busy}>📱 Use phone</button>
          : <button type="button" className="btn btn-sm" disabled title="MotelMitra is running on this PC only. Set HOST_ON_WIFI=yes in backend\.env and run start_app.bat to use a phone.">📱 Use phone (WiFi off)</button>}
        <button type="button" className="btn btn-sm" onClick={() => setCam(true)} disabled={busy}>📷 Webcam</button>
        <button type="button" className="btn btn-sm" onClick={() => setScan(true)} disabled={busy}>🖨 Scan</button>
        <button type="button" className="btn btn-sm" onClick={() => fileRef.current?.click()} disabled={busy}>📁 Choose file</button>
        <input ref={fileRef} type="file" accept="image/*" multiple={!isDl} hidden
          onChange={(e) => { const f = [...e.target.files]; e.target.value = ''; if (f.length) send(f, 'FILE') }} />
        <span className="tiny muted">{busy ? 'Uploading…' : `or drag a photo here, or paste (Ctrl+V)${isDl ? ` · adding: ${side === 'DL_FRONT' ? 'Front' : 'Back'}` : ''}`}</span>
      </div>
      <Alert>{err}</Alert>

      {phone && <PhoneModal kind={isDl ? 'DL_FRONT' : 'DAMAGE'} stay={stay} onPhoto={onAdd} onClose={() => setPhone(false)} />}
      {scan && <ScanModal title={isDl ? `Scan DL ${side === 'DL_FRONT' ? 'front' : 'back'}` : 'Scan: room damage'} dl={isDl}
        onClose={() => setScan(false)}
        onUse={async (blob) => { await send([blob], 'SCAN'); if (isDl) setScan(false) }} />}
      {cam && <WebcamModal title={isDl ? `Webcam: DL ${side === 'DL_FRONT' ? 'front' : 'back'}` : 'Webcam: room damage'}
        onClose={() => setCam(false)}
        onCapture={async (blob) => { await send([blob], 'WEBCAM'); if (isDl) setCam(false) }} />}
    </div>
  )
}

/** "Use phone": QR code for a phone on the motel WiFi; photos appear here as soon as they are sent. */
function PhoneModal({ kind, stay, onPhoto, onClose }) {
  const [sess, setSess] = useState(null)
  const [err, setErr] = useState('')
  const [count, setCount] = useState(0)
  const [left, setLeft] = useState(600)
  const seen = useRef(new Set())
  const onPhotoRef = useRef(onPhoto)
  useEffect(() => { onPhotoRef.current = onPhoto }, [onPhoto])

  useEffect(() => {
    api.post('/photo-sessions/', { kind, stay: stay || null, origin: window.location.origin })
      .then((r) => setSess(r.data)).catch((e) => setErr(errorText(e)))
  }, [kind, stay])

  useEffect(() => {
    if (!sess) return
    const poll = setInterval(async () => {
      try {
        const { data } = await api.get(`/photo-sessions/${sess.token}/`)
        data.photos.forEach((p) => {
          if (!seen.current.has(p.id)) { seen.current.add(p.id); onPhotoRef.current(p); setCount((c) => c + 1) }
        })
      } catch { /* keep trying */ }
    }, 2000)
    const tick = setInterval(() => setLeft(Math.max(0, Math.round((new Date(sess.expires_at) - new Date()) / 1000))), 1000)
    return () => { clearInterval(poll); clearInterval(tick) }
  }, [sess])

  return (
    <Modal title="Use phone camera" onClose={onClose} width={460}>
      <Alert>{err}</Alert>
      {sess && (
        <div className="phone-qr">
          <div className="qr" dangerouslySetInnerHTML={{ __html: sess.qr_svg }} />
          <ol className="tiny">
            <li>Open the camera on a phone connected to the <strong>motel WiFi</strong>.</li>
            <li>Point it at this code and tap the link.</li>
            <li>Take the {kind === 'DAMAGE' ? 'damage photos' : 'DL front and back'}. They appear here automatically.</li>
          </ol>
          <div className="tiny muted qr-url">{sess.url}</div>
          <div className={`qr-status ${count ? 'got' : ''}`}>
            {count ? `✓ ${count} photo${count > 1 ? 's' : ''} received` : 'Waiting for the phone…'}
            <span className="tiny muted"> · link expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</span>
          </div>
        </div>
      )}
      <div className="form-actions"><button className="btn btn-primary" onClick={onClose}>Done</button></div>
    </Modal>
  )
}

/** Webcam on this PC (works on http://localhost; browsers block cameras on plain WiFi addresses). */
function WebcamModal({ title, onCapture, onClose }) {
  const video = useRef(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [shots, setShots] = useState(0)

  const unsupported = !navigator.mediaDevices?.getUserMedia
    ? 'The webcam only works when MotelMitra is opened on this PC as http://localhost:5173. Use "Use phone" instead.' : ''

  useEffect(() => {
    let stream = null
    if (unsupported) return undefined
    navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1920 }, height: { ideal: 1080 } } })
      .then((s) => { stream = s; if (video.current) video.current.srcObject = s })
      .catch(() => setErr('No webcam found, or the browser blocked it. Allow the camera in the address bar, or use "Use phone".'))
    return () => stream?.getTracks().forEach((t) => t.stop())
  }, [unsupported])

  async function capture() {
    const v = video.current
    if (!v?.videoWidth) return
    const c = document.createElement('canvas')
    c.width = v.videoWidth
    c.height = v.videoHeight
    c.getContext('2d').drawImage(v, 0, 0)
    setBusy(true)
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9))
    await onCapture(blob)
    setShots((n) => n + 1)
    setBusy(false)
  }

  return (
    <Modal title={title} onClose={onClose} width={760}>
      <Alert>{unsupported || err}</Alert>
      {!unsupported && !err && <video ref={video} autoPlay playsInline muted className="webcam" />}
      <div className="form-actions">
        {shots > 0 && <span className="tiny muted">✓ {shots} captured</span>}
        <button className="btn" onClick={onClose}>Close</button>
        {!unsupported && !err && <button className="btn btn-primary" onClick={capture} disabled={busy}>{busy ? 'Saving…' : '📸 Capture'}</button>}
      </div>
    </Modal>
  )
}

/** Read-only gallery with delete, for the guest page. */
export function PhotoGallery({ photos, onDelete }) {
  if (!photos.length) return <p className="muted tiny">No photos.</p>
  return (
    <div className="gallery">
      {photos.map((p) => (
        <figure key={p.id}>
          <AuthImage photo={p} />
          <figcaption>
            <strong>{p.kind_label}</strong> · {fmtDateTime(p.created_at)}
            <div className="tiny muted">{p.file_name.split('/').pop()}{p.uploaded_by_name && ` · ${p.uploaded_by_name}`}{p.via === 'REUSED' && ' · from last stay'}</div>
            {onDelete && <button type="button" className="link-btn danger" onClick={() => onDelete(p)}>Delete</button>}
          </figcaption>
        </figure>
      ))}
    </div>
  )
}

/** Read an error sent back as a blob (scanner image requests) */
async function blobError(e) {
  const d = e?.response?.data
  if (d instanceof Blob) {
    try { const j = JSON.parse(await d.text()); return j.detail || Object.values(j).flat().join(' ') } catch { /* not JSON */ }
  }
  return errorText(e)
}

/**
 * WiFi printer / scanner.
 *  Scan now: MotelMitra asks the printer to scan (eSCL / AirScan).
 *  Scan folder: newest scans saved by the printer's own "Scan to PC" into a folder on this PC.
 */
function ScanModal({ title, dl, onUse, onClose }) {
  const [cfg, setCfg] = useState(null)
  const [tab, setTab] = useState(null)
  const [area, setArea] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [preview, setPreview] = useState(null)     // { blob, url }
  const [files, setFiles] = useState(null)
  const [used, setUsed] = useState(0)

  useEffect(() => { api.get('/settings/').then((r) => setCfg(r.data)).catch((e) => setErr(errorText(e))) }, [])
  const hasDirect = Boolean(cfg?.scanner_address)
  const hasFolder = Boolean(cfg?.scan_folder)
  const current = tab || (hasDirect ? 'direct' : hasFolder ? 'folder' : null)
  const areaNow = area || (dl ? (cfg?.scanner_area || 'DL') : 'PAGE')

  const loadFolder = useCallback(() => {
    api.get('/scanner/folder/').then((r) => { setFiles(r.data.files); setErr('') }).catch((e) => setErr(errorText(e)))
  }, [])
  useEffect(() => {
    if (current !== 'folder') return undefined
    loadFolder()
    const t = setInterval(loadFolder, 5000)    // a new scan from the printer shows up by itself
    return () => clearInterval(t)
  }, [current, loadFolder])
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url) }, [preview])

  async function scanNow() {
    setBusy(true); setErr(''); setPreview(null)
    try {
      const { data } = await api.post('/scanner/scan/', { area: areaNow }, { responseType: 'blob', timeout: 120000 })
      setPreview({ blob: data, url: URL.createObjectURL(data) })
    } catch (e) { setErr(await blobError(e)) }
    setBusy(false)
  }
  async function keepScan(blob) {
    setBusy(true)
    await onUse(blob)
    setUsed((n) => n + 1)
    setPreview(null)
    setBusy(false)
  }
  async function pickScan(name) {
    setBusy(true); setErr('')
    try {
      const { data } = await api.get('/scanner/folder/file/', { params: { name }, responseType: 'blob' })
      await onUse(data)
      setUsed((n) => n + 1)
    } catch (e) { setErr(await blobError(e)) }
    setBusy(false)
  }

  return (
    <Modal title={title} onClose={onClose} width={720}>
      {cfg && !hasDirect && !hasFolder && (
        <Alert kind="info">No scanner set up yet. The admin can add the printer's IP address or a scan folder in <strong>Charges &amp; Fees → Scanner</strong>.</Alert>
      )}
      {(hasDirect || hasFolder) && (
        <div className="tabs scan-tabs">
          {hasDirect && <button className={current === 'direct' ? 'on' : ''} onClick={() => setTab('direct')}>Scan now (printer)</button>}
          {hasFolder && <button className={current === 'folder' ? 'on' : ''} onClick={() => setTab('folder')}>Scan folder</button>}
        </div>
      )}
      <Alert>{err}</Alert>

      {current === 'direct' && (
        <div className="scan-direct">
          {!preview && (
            <>
              <ol className="tiny scan-steps">
                <li>{dl ? <>Put the licence face down in the <strong>top-left corner</strong> of the glass</> : 'Put the item face down on the glass'} and close the lid.</li>
                <li>Press <strong>Start scan</strong>. It takes about 10 to 30 seconds.</li>
              </ol>
              <div className="scan-row">
                <div className="seg seg-sm">
                  <button type="button" className={areaNow === 'DL' ? 'on' : ''} onClick={() => setArea('DL')}>Card size (corner)</button>
                  <button type="button" className={areaNow === 'PAGE' ? 'on' : ''} onClick={() => setArea('PAGE')}>Full page</button>
                </div>
                <button className="btn btn-primary" onClick={scanNow} disabled={busy}>{busy ? 'Scanning…' : '🖨 Start scan'}</button>
              </div>
            </>
          )}
          {preview && (
            <>
              <img src={preview.url} alt="Scan" className="photo-big" />
              <div className="form-actions">
                <button className="btn" onClick={scanNow} disabled={busy}>Scan again</button>
                <button className="btn btn-primary" onClick={() => keepScan(preview.blob)} disabled={busy}>{busy ? 'Saving…' : 'Use this scan'}</button>
              </div>
            </>
          )}
        </div>
      )}

      {current === 'folder' && (
        <div className="scan-folder">
          <p className="tiny muted">Press <strong>Scan to PC</strong> on the printer. New scans appear here by themselves (last 2 days, newest first). Click one to use it.</p>
          {files && !files.length && <p className="muted">No scans yet.</p>}
          <div className="scan-grid">
            {(files || []).map((f) => (
              <button type="button" key={f.name} className="scan-pick" onClick={() => pickScan(f.name)} disabled={busy}>
                <ScanThumb name={f.name} />
                <span className="tiny">{f.name}</span>
                <span className="tiny muted">{fmtDateTime(f.modified)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="form-actions">
        {used > 0 && <span className="tiny muted">✓ {used} added</span>}
        <button className="btn" onClick={onClose}>{used ? 'Done' : 'Close'}</button>
      </div>
    </Modal>
  )
}

function ScanThumb({ name }) {
  const [src, setSrc] = useState(null)
  useEffect(() => {
    let url = null
    let live = true
    api.get('/scanner/folder/file/', { params: { name }, responseType: 'blob' })
      .then((r) => { url = URL.createObjectURL(r.data); if (live) setSrc(url) }).catch(() => {})
    return () => { live = false; if (url) URL.revokeObjectURL(url) }
  }, [name])
  return src ? <img src={src} alt={name} /> : <div className="auth-img loading" />
}
