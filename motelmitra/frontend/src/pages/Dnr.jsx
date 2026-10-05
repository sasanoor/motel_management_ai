import { useCallback, useEffect, useState } from 'react'
import api, { errorText } from '../api'
import { Alert, Empty, Modal, PageHead } from '../components/ui'
import { fmtDate, nameParts } from '../utils'

const BLANK = {
  first_name: '', middle_name: '', last_name: '', phone: '', license_plate: '', car: '', address: '', city: '', state: '', zip_code: '',
  dnr_reason: '', do_not_rent: true,
}

/** Do Not Rent list: add past customers directly, edit reasons, remove from the list. */
export default function Dnr() {
  const [q, setQ] = useState('')
  const [rows, setRows] = useState(null)
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  const [edit, setEdit] = useState(null)

  const load = useCallback(() => {
    api.get('/guests/', { params: { dnr: 1, q: q || undefined } })
      .then((r) => { setRows(r.data); setErr('') })
      .catch((e) => setErr(errorText(e)))
  }, [q])
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t) }, [load])

  async function remove(g) {
    if (!window.confirm(`Remove ${g.name} from the Do Not Rent list?`)) return
    try {
      await api.patch(`/guests/${g.id}/`, { do_not_rent: false })
      setMsg(`${g.name} removed from the DNR list.`)
      load()
    } catch (e) { setErr(errorText(e)) }
  }

  return (
    <>
      <PageHead title="DNR List" sub="Guests who must not be rented to. Add past customers here directly.">
        <button className="btn btn-danger" onClick={() => { setMsg(''); setEdit({ ...BLANK }) }}>+ Add to DNR</button>
      </PageHead>
      <div className="filters">
        <input className="search" placeholder="Search name, phone or plate…" value={q} onChange={(e) => setQ(e.target.value)} />
        {rows && <span className="muted tiny">{rows.length} on the list</span>}
      </div>
      <Alert>{err}</Alert>
      <Alert kind="success">{msg}</Alert>
      <div className="card no-pad">
        {rows && !rows.length && <Empty>{q ? 'No DNR guests match.' : 'The DNR list is empty.'}</Empty>}
        {rows?.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Name</th><th>Phone</th><th>Plate</th><th>Car</th><th>Location</th><th>Reason</th><th>Added</th><th className="num">Stays</th><th></th></tr>
              </thead>
              <tbody>
                {rows.map((g) => (
                  <tr key={g.id}>
                    <td><strong>{g.name}</strong> <span className="pill pill-red ml">DNR</span></td>
                    <td>{g.phone}</td>
                    <td>{g.license_plate}</td>
                    <td>{g.car}</td>
                    <td>{[g.city, g.state].filter(Boolean).join(', ')}</td>
                    <td className="wrap dnr-reason">{g.dnr_reason || <span className="muted">—</span>}</td>
                    <td>{fmtDate(g.dnr_marked_at)}<div className="tiny muted">{g.dnr_marked_by_name}</div></td>
                    <td className="num">{g.stay_count}</td>
                    <td className="row-actions">
                      <button className="btn btn-sm" onClick={() => { setMsg(''); setEdit(g) }}>Edit</button>
                      <button className="btn btn-sm btn-danger-outline" onClick={() => remove(g)}>Remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {edit && (
        <DnrForm
          initial={edit}
          onClose={() => setEdit(null)}
          onSaved={(g) => {
            setEdit(null)
            setMsg(g.merged
              ? `${g.name} was already a guest (same phone or plate). Their record is now flagged DNR.`
              : `${g.name} ${edit.id ? 'updated' : 'added to the DNR list'}.`)
            load()
          }}
        />
      )}
    </>
  )
}

function DnrForm({ initial, onClose, onSaved }) {
  const [f, setF] = useState(() => ({ ...initial, ...nameParts(initial) }))
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value })

  async function save(e) {
    e.preventDefault()
    if (!f.phone.trim() && !f.license_plate.trim()) {
      if (!window.confirm('No phone or plate entered. The guest can then only be matched by exact name. Save anyway?')) return
    }
    setBusy(true)
    setErr('')
    try {
      const { name: _old, ...rest } = f  // name is built from the parts on the server
      const body = { ...rest, do_not_rent: true }
      const { data } = f.id ? await api.patch(`/guests/${f.id}/`, body) : await api.post('/guests/', body)
      onSaved(data)
    } catch (e2) {
      setErr(errorText(e2))
      setBusy(false)
    }
  }

  return (
    <Modal title={f.id ? `Edit DNR: ${initial.name}` : 'Add to Do Not Rent list'} onClose={onClose} width={640}>
      <Alert>{err}</Alert>
      <form onSubmit={save} className="form-grid cols-2">
        <div className="span-2 name-row">
          <label><span>First name <span className="req">*</span></span>
            <input value={f.first_name} onChange={set('first_name')} required autoFocus autoComplete="off" />
          </label>
          <label>Middle name
            <input value={f.middle_name} onChange={set('middle_name')} autoComplete="off" />
          </label>
          <label><span>Last name <span className="req">*</span></span>
            <input value={f.last_name} onChange={set('last_name')} required autoComplete="off" />
          </label>
        </div>
        <label>Phone
          <input value={f.phone} onChange={set('phone')} inputMode="tel" />
        </label>
        <label>License plate
          <input value={f.license_plate} onChange={set('license_plate')} />
        </label>
        <label className="span-2">Reason
          <input value={f.dnr_reason} onChange={set('dnr_reason')} placeholder="e.g. Damaged room, smoking, unpaid balance" />
        </label>
        <label>Car
          <input value={f.car} onChange={set('car')} placeholder="Make / model / color" />
        </label>
        <label>City
          <input value={f.city} onChange={set('city')} />
        </label>
        <label>State
          <input value={f.state} onChange={set('state')} />
        </label>
        <label>Zip
          <input value={f.zip_code} onChange={set('zip_code')} />
        </label>
        <label className="span-2">Address
          <input value={f.address} onChange={set('address')} />
        </label>
        <p className="span-2 tiny muted">Phone and plate are what check-in matches on, so enter at least one if you have it.</p>
        <div className="span-2 form-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-danger" disabled={busy}>{busy ? 'Saving…' : f.id ? 'Save' : 'Add to DNR'}</button>
        </div>
      </form>
    </Modal>
  )
}
