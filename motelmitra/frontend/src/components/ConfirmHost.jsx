import { useEffect, useRef, useState } from 'react'
import { setConfirmHost } from '../confirm'

/** Draws the confirm box asked for by confirmBox(). Esc = cancel, Enter = confirm. */
export default function ConfirmHost() {
  const [req, setReq] = useState(null)
  const okRef = useRef(null)

  useEffect(() => { setConfirmHost(setReq); return () => setConfirmHost(null) }, [])
  useEffect(() => {
    if (!req) return
    okRef.current?.focus()
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); done(false) } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [req]) // eslint-disable-line react-hooks/exhaustive-deps

  function done(ok) { const r = req; setReq(null); r?.resolve(ok) }
  if (!req) return null

  const danger = req.tone !== 'primary'
  return (
    <div className="modal-back confirm-back" onMouseDown={() => done(false)}>
      <div className="confirm-box" role="alertdialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <div className="confirm-head">
          <span className={`confirm-icon ${danger ? 'ci-danger' : 'ci-primary'}`}>{danger ? '!' : '?'}</span>
          <h3 className={danger ? 'confirm-title-danger' : ''}>{req.title || 'Please confirm'}</h3>
        </div>
        <div className="confirm-body">
          {req.message && <p className="confirm-msg">{req.message}</p>}
          {req.details?.length > 0 && (
            <div className="confirm-details">
              {req.details.filter(Boolean).map(([k, v]) => (
                <div key={k} className="cd-row"><span>{k}</span><b>{v}</b></div>
              ))}
            </div>
          )}
        </div>
        <div className="confirm-foot">
          <button type="button" className="btn" onClick={() => done(false)}>{req.cancelText || 'Cancel'}</button>
          <button type="button" ref={okRef} className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} onClick={() => done(true)}>
            {req.confirmText || (danger ? 'Delete' : 'OK')}
          </button>
        </div>
      </div>
    </div>
  )
}
