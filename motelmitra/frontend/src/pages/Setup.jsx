import { useEffect, useState } from 'react'
import api, { errorText } from '../api'
import { useAuth } from '../auth'
import { Alert, Empty, Modal, PageHead } from '../components/ui'
import { ROLES, fmtDate, money, num } from '../utils'

/* ------------------------------------------------------------------ shared */
function useList(url) {
  const [rows, setRows] = useState(null)
  const [err, setErr] = useState('')
  const load = () => api.get(url).then((r) => setRows(r.data)).catch((e) => setErr(errorText(e)))
  useEffect(() => { load() }, [url]) // eslint-disable-line react-hooks/exhaustive-deps
  return { rows, err, setErr, load }
}

function FormModal({ title, initial, fields, onSubmit, onClose }) {
  const [f, setF] = useState(initial)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    setErr('')
    try {
      await onSubmit(f)
    } catch (e2) {
      setErr(errorText(e2))
      setBusy(false)
    }
  }
  return (
    <Modal title={title} onClose={onClose} width={620}>
      <Alert>{err}</Alert>
      <form onSubmit={submit} className="form-grid cols-2">
        {fields.map((fd) => (
          <label key={fd.name} className={fd.wide ? 'span-2' : ''}>
            {fd.label}
            {fd.type === 'select' ? (
              <select value={f[fd.name] ?? ''} onChange={(e) => setF({ ...f, [fd.name]: e.target.value })} required={fd.required}>
                {fd.placeholder && <option value="">{fd.placeholder}</option>}
                {fd.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            ) : fd.type === 'checkbox' ? (
              <span className="check"><input type="checkbox" checked={!!f[fd.name]} onChange={(e) => setF({ ...f, [fd.name]: e.target.checked })} /> {fd.hint}</span>
            ) : (
              <input
                type={fd.type || 'text'} step={fd.step} min={fd.min} value={f[fd.name] ?? ''}
                required={fd.required} placeholder={fd.placeholder}
                onChange={(e) => setF({ ...f, [fd.name]: e.target.value })}
              />
            )}
          </label>
        ))}
        <div className="span-2 form-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  )
}

const Active = ({ on }) => <span className={`pill ${on ? 'pill-green' : 'pill-grey'}`}>{on ? 'Active' : 'Inactive'}</span>

/* ------------------------------------------------------------------ room types */
export function RoomTypes() {
  const { rows, err, setErr, load } = useList('/room-types/')
  const [edit, setEdit] = useState(null)
  const fields = [
    { name: 'name', label: 'Room type', required: true, placeholder: 'King, Queen, Double, Suite, Jacuzzi, Handicap' },
    { name: 'default_rate', label: 'Daily rate (per night)', type: 'number', step: '0.01', min: '0', required: true },
    { name: 'weekly_rate', label: 'Weekly rate (per week)', type: 'number', step: '0.01', min: '0', placeholder: 'Blank = daily × 7' },
    { name: 'monthly_rate', label: 'Monthly rate (per month)', type: 'number', step: '0.01', min: '0', placeholder: 'Blank = daily × 30' },
    { name: 'description', label: 'Description', wide: true },
    { name: 'is_active', label: 'Status', type: 'checkbox', hint: 'Active' },
  ]
  async function save(f) {
    const body = { ...f, weekly_rate: f.weekly_rate || 0, monthly_rate: f.monthly_rate || 0 }
    if (f.id) await api.put(`/room-types/${f.id}/`, body)
    else await api.post('/room-types/', body)
    setEdit(null)
    load()
  }
  async function remove(rt) {
    if (!window.confirm(`Remove room type ${rt.name}?`)) return
    try { await api.delete(`/room-types/${rt.id}/`); load() } catch (e) { setErr(errorText(e)) }
  }
  return (
    <>
      <PageHead title="Room Types & Rates" sub="Daily, weekly and monthly rates are pre-filled at check-in; clerks can change them per guest.">
        <button className="btn btn-primary" onClick={() => setEdit({ name: '', default_rate: '', weekly_rate: '', monthly_rate: '', description: '', is_active: true })}>+ Add room type</button>
      </PageHead>
      <Alert>{err}</Alert>
      <div className="card no-pad">
        {rows && !rows.length && <Empty>No room types yet. Add King, Queen, Double, Suite, Jacuzzi, Handicap.</Empty>}
        {rows?.length > 0 && (
          <table className="table">
            <thead><tr><th>Room type</th><th className="num">Daily</th><th className="num">Weekly</th><th className="num">Monthly</th><th className="num">Rooms</th><th>Description</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td><strong>{r.name}</strong></td>
                  <td className="num">{money(r.default_rate)}</td>
                  <td className="num">{num(r.weekly_rate) ? money(r.weekly_rate) : <span className="muted tiny">{money(num(r.default_rate) * 7)} (×7)</span>}</td>
                  <td className="num">{num(r.monthly_rate) ? money(r.monthly_rate) : <span className="muted tiny">{money(num(r.default_rate) * 30)} (×30)</span>}</td>
                  <td className="num">{r.room_count}</td>
                  <td>{r.description}</td>
                  <td><Active on={r.is_active} /></td>
                  <td className="row-actions">
                    <button className="btn btn-sm" onClick={() => setEdit(r)}>Edit</button>
                    <button className="btn btn-sm btn-danger-outline" onClick={() => remove(r)}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {edit && <FormModal title={edit.id ? 'Edit room type' : 'Add room type'} initial={edit} fields={fields} onSubmit={save} onClose={() => setEdit(null)} />}
    </>
  )
}

/* ------------------------------------------------------------------ rooms */
export function Rooms() {
  const { rows, err, setErr, load } = useList('/rooms/')
  const types = useList('/room-types/')
  const [edit, setEdit] = useState(null)
  const [bulk, setBulk] = useState(false)
  const typeOptions = (types.rows || []).filter((t) => t.is_active).map((t) => ({ value: t.id, label: `${t.name} (${money(t.default_rate)})` }))
  const fields = [
    { name: 'number', label: 'Room number', required: true },
    { name: 'room_type', label: 'Room type', type: 'select', options: typeOptions, required: true, placeholder: 'Select…' },
    { name: 'floor', label: 'Floor' },
    { name: 'is_active', label: 'Status', type: 'checkbox', hint: 'Active' },
    { name: 'notes', label: 'Notes', wide: true },
  ]
  async function save(f) {
    if (f.id) await api.put(`/rooms/${f.id}/`, f)
    else await api.post('/rooms/', f)
    setEdit(null)
    load()
  }
  async function saveBulk(f) {
    const from = parseInt(f.from, 10)
    const to = parseInt(f.to, 10)
    if (!(to >= from) || to - from > 200) throw new Error('Enter a valid range (max 200 rooms).')
    const failed = []
    for (let n = from; n <= to; n++) {
      try { await api.post('/rooms/', { number: String(n), room_type: f.room_type, floor: f.floor || '', is_active: true }) }
      catch { failed.push(n) }
    }
    setBulk(false)
    load()
    if (failed.length) setErr(`Skipped (already exist): ${failed.join(', ')}`)
  }
  async function remove(r) {
    if (!window.confirm(`Remove room ${r.number}?`)) return
    try { await api.delete(`/rooms/${r.id}/`); load() } catch (e) { setErr(errorText(e)) }
  }
  return (
    <>
      <PageHead title="Rooms" sub={rows ? `${rows.filter((r) => r.is_active).length} active rooms` : ''}>
        <button className="btn" onClick={() => setBulk(true)} disabled={!typeOptions.length}>+ Add range</button>
        <button className="btn btn-primary" onClick={() => setEdit({ number: '', room_type: '', floor: '', notes: '', is_active: true })} disabled={!typeOptions.length}>+ Add room</button>
      </PageHead>
      {types.rows && !typeOptions.length && <Alert kind="info">Create room types first (Setup → Room Types & Rates).</Alert>}
      <Alert>{err}</Alert>
      <div className="card no-pad">
        {rows && !rows.length && <Empty>No rooms yet.</Empty>}
        {rows?.length > 0 && (
          <table className="table">
            <thead><tr><th>Room</th><th>Type</th><th className="num">Daily rate</th><th>Floor</th><th>Notes</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td><span className="room-chip">{r.number}</span></td>
                  <td>{r.room_type_name}</td>
                  <td className="num">{money(r.default_rate)}</td>
                  <td>{r.floor}</td>
                  <td>{r.notes}</td>
                  <td><Active on={r.is_active} /></td>
                  <td className="row-actions">
                    <button className="btn btn-sm" onClick={() => setEdit(r)}>Edit</button>
                    <button className="btn btn-sm btn-danger-outline" onClick={() => remove(r)}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {edit && <FormModal title={edit.id ? `Edit room ${edit.number}` : 'Add room'} initial={edit} fields={fields} onSubmit={save} onClose={() => setEdit(null)} />}
      {bulk && (
        <FormModal
          title="Add a range of rooms" initial={{ from: '', to: '', room_type: '', floor: '' }} onSubmit={saveBulk} onClose={() => setBulk(false)}
          fields={[
            { name: 'from', label: 'From room #', type: 'number', required: true },
            { name: 'to', label: 'To room #', type: 'number', required: true },
            { name: 'room_type', label: 'Room type', type: 'select', options: typeOptions, required: true, placeholder: 'Select…' },
            { name: 'floor', label: 'Floor' },
          ]}
        />
      )}
    </>
  )
}

/* ------------------------------------------------------------------ users */
export function Users() {
  const { user } = useAuth()
  const { rows, err, setErr, load } = useList('/users/')
  const [edit, setEdit] = useState(null)
  const fields = (isNew) => [
    { name: 'username', label: 'Username', required: true },
    { name: 'password', label: isNew ? 'Password' : 'New password (leave blank to keep)', type: 'password', required: isNew },
    { name: 'first_name', label: 'First name' },
    { name: 'last_name', label: 'Last name' },
    { name: 'phone', label: 'Phone' },
    { name: 'email', label: 'Email', type: 'email' },
    { name: 'role', label: 'Role', type: 'select', options: [{ value: 'CLIENT_USER', label: 'Client User (front desk)' }, { value: 'MAINTENANCE', label: 'Maintenance (checkout rooms + notes only)' }, { value: 'CLIENT_ADMIN', label: 'Client Admin' }] },
    { name: 'is_active', label: 'Status', type: 'checkbox', hint: 'Active (can log in)' },
  ]
  async function save(f) {
    const body = { ...f }
    if (!body.password) delete body.password
    if (f.id) await api.patch(`/users/${f.id}/`, body)
    else await api.post('/users/', body)
    setEdit(null)
    load()
  }
  async function toggle(u) {
    try { await api.patch(`/users/${u.id}/`, { is_active: !u.is_active }); load() } catch (e) { setErr(errorText(e)) }
  }
  return (
    <>
      <PageHead title="Users" sub="Front desk and maintenance staff for your motel">
        <button className="btn btn-primary" onClick={() => setEdit({ username: '', password: '', first_name: '', last_name: '', phone: '', email: '', role: 'CLIENT_USER', is_active: true })}>+ Add user</button>
      </PageHead>
      <Alert>{err}</Alert>
      <div className="card no-pad">
        {rows?.length > 0 && (
          <table className="table">
            <thead><tr><th>Username</th><th>Name</th><th>Role</th><th>Phone</th><th>Since</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.id}>
                  <td><strong>{u.username}</strong></td>
                  <td>{u.full_name}</td>
                  <td>{ROLES[u.role]}</td>
                  <td>{u.phone}</td>
                  <td>{fmtDate(u.date_joined)}</td>
                  <td><Active on={u.is_active} /></td>
                  <td className="row-actions">
                    <button className="btn btn-sm" onClick={() => setEdit({ ...u, password: '' })}>Edit</button>
                    {u.id !== user.id && <button className="btn btn-sm" onClick={() => toggle(u)}>{u.is_active ? 'Deactivate' : 'Activate'}</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {edit && <FormModal title={edit.id ? `Edit ${edit.username}` : 'Add user'} initial={edit} fields={fields(!edit.id)} onSubmit={save} onClose={() => setEdit(null)} />}
    </>
  )
}

/* ------------------------------------------------------------------ guest directory */
export function Directory() {
  const [q, setQ] = useState('')
  const [dnr, setDnr] = useState(false)
  const [rows, setRows] = useState(null)
  const [err, setErr] = useState('')
  const load = () => api.get('/guests/', { params: { q: q || undefined, dnr: dnr ? 1 : undefined } }).then((r) => setRows(r.data)).catch((e) => setErr(errorText(e)))
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t) }, [q, dnr]) // eslint-disable-line react-hooks/exhaustive-deps
  async function toggle(g) {
    if (!window.confirm(g.do_not_rent ? `Remove Do Not Rent from ${g.name}?` : `Flag ${g.name} as Do Not Rent?`)) return
    try { await api.patch(`/guests/${g.id}/`, { do_not_rent: !g.do_not_rent }); load() } catch (e) { setErr(errorText(e)) }
  }
  return (
    <>
      <PageHead title="Guest Directory" sub="Every guest who has stayed, with Do Not Rent flags" />
      <div className="filters">
        <input className="search" placeholder="Search name, phone or plate…" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="inline check"><input type="checkbox" checked={dnr} onChange={(e) => setDnr(e.target.checked)} /> Do Not Rent only</label>
      </div>
      <Alert>{err}</Alert>
      <div className="card no-pad">
        {rows && !rows.length && <Empty>No guests found.</Empty>}
        {rows?.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Name</th><th>Phone</th><th>Plate</th><th>Car</th><th>City</th><th className="num">Stays</th><th>Last stay</th><th>DNR</th><th></th></tr></thead>
              <tbody>
                {rows.map((g) => (
                  <tr key={g.id}>
                    <td><strong>{g.name}</strong></td>
                    <td>{g.phone}</td>
                    <td>{g.license_plate}</td>
                    <td>{g.car}</td>
                    <td>{[g.city, g.state].filter(Boolean).join(', ')}</td>
                    <td className="num">{g.stay_count}</td>
                    <td>{fmtDate(g.last_stay)}</td>
                    <td>{g.do_not_rent ? <span className="pill pill-red">DNR</span> : ''}</td>
                    <td><button className="btn btn-sm" onClick={() => toggle(g)}>{g.do_not_rent ? 'Clear DNR' : 'Flag DNR'}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}

/* ------------------------------------------------------------------ super admin: clients */
export function Clients() {
  const { rows, err, setErr, load } = useList('/clients/')
  const [edit, setEdit] = useState(null)
  const [viewUsers, setViewUsers] = useState(null)

  const base = [
    { name: 'name', label: 'Motel name', required: true, wide: true },
    { name: 'address', label: 'Address', wide: true },
    { name: 'city', label: 'City' },
    { name: 'state', label: 'State' },
    { name: 'zip_code', label: 'Zip' },
    { name: 'phone', label: 'Phone' },
    { name: 'email', label: 'Email', type: 'email', wide: true },
  ]
  const adminFields = [
    { name: 'admin_username', label: 'Client admin username', required: true },
    { name: 'admin_password', label: 'Client admin password', type: 'password', required: true },
    { name: 'admin_first_name', label: 'Admin first name' },
    { name: 'admin_last_name', label: 'Admin last name' },
  ]
  async function save(f) {
    if (f.id) await api.patch(`/clients/${f.id}/`, f)
    else await api.post('/clients/', f)
    setEdit(null)
    load()
  }
  async function toggle(c) {
    if (!window.confirm(`${c.is_active ? 'Deactivate' : 'Activate'} ${c.name}? ${c.is_active ? 'Its users will not be able to log in.' : ''}`)) return
    try { await api.patch(`/clients/${c.id}/`, { is_active: !c.is_active }); load() } catch (e) { setErr(errorText(e)) }
  }
  async function showUsers(c) {
    try { const { data } = await api.get(`/clients/${c.id}/users/`); setViewUsers({ client: c, users: data }) } catch (e) { setErr(errorText(e)) }
  }
  return (
    <>
      <PageHead title="Clients" sub="Motels on MotelMitra">
        <button className="btn btn-primary" onClick={() => setEdit({ name: '', address: '', city: '', state: '', zip_code: '', phone: '', email: '', admin_username: '', admin_password: '', admin_first_name: '', admin_last_name: '' })}>+ Onboard client</button>
      </PageHead>
      <Alert>{err}</Alert>
      <div className="card no-pad">
        {rows && !rows.length && <Empty>No clients yet.</Empty>}
        {rows?.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Motel</th><th>Location</th><th>Phone</th><th className="num">Rooms</th><th className="num">Users</th><th>Since</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id}>
                    <td><strong>{c.name}</strong><div className="tiny muted">{c.email}</div></td>
                    <td>{[c.city, c.state].filter(Boolean).join(', ')}</td>
                    <td>{c.phone}</td>
                    <td className="num">{c.room_count}</td>
                    <td className="num">{c.user_count}</td>
                    <td>{fmtDate(c.created_at)}</td>
                    <td><Active on={c.is_active} /></td>
                    <td className="row-actions">
                      <button className="btn btn-sm" onClick={() => showUsers(c)}>Users</button>
                      <button className="btn btn-sm" onClick={() => setEdit(c)}>Edit</button>
                      <button className="btn btn-sm" onClick={() => toggle(c)}>{c.is_active ? 'Deactivate' : 'Activate'}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {edit && (
        <FormModal
          title={edit.id ? `Edit ${edit.name}` : 'Onboard client'} initial={edit} onSubmit={save} onClose={() => setEdit(null)}
          fields={edit.id ? base : [...base, ...adminFields]}
        />
      )}
      {viewUsers && (
        <Modal title={`${viewUsers.client.name}: users`} onClose={() => setViewUsers(null)} width={640}>
          <table className="table">
            <thead><tr><th>Username</th><th>Name</th><th>Role</th><th>Status</th></tr></thead>
            <tbody>
              {viewUsers.users.map((u) => (
                <tr key={u.id}><td>{u.username}</td><td>{u.full_name}</td><td>{ROLES[u.role]}</td><td><Active on={u.is_active} /></td></tr>
              ))}
            </tbody>
          </table>
        </Modal>
      )}
    </>
  )
}

/* ------------------------------------------------------------------ charges & fees */
export function ChargesSettings() {
  const [f, setF] = useState(null)
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { api.get('/settings/').then((r) => setF(r.data)).catch((e) => setErr(errorText(e))) }, [])
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value })

  async function save(e) {
    e.preventDefault()
    setBusy(true); setErr(''); setMsg('')
    try {
      const { data } = await api.patch('/settings/', f)
      setF(data)
      setMsg('Saved. New check-ins will use these charges.')
    } catch (e2) { setErr(errorText(e2)) }
    setBusy(false)
  }

  return (
    <>
      <PageHead title="Charges & Fees" sub="Default extra charges at check-in. Clerks can change any amount per guest." />
      <Alert>{err}</Alert>
      <Alert kind="success">{msg}</Alert>
      {f && (
        <form className="card settings-card" onSubmit={save}>
          <div className="form-grid cols-2">
            <label>Card payment fee (%)
              <input type="number" step="0.01" min="0" max="20" value={f.card_fee_percent} onChange={set('card_fee_percent')} />
              <span className="hint">Added on the amount paid by card. Example: 3% on $100 = $3.00</span>
            </label>
            <label>Pet fee ($ per pet, per stay)
              <input type="number" step="0.01" min="0" value={f.pet_fee} onChange={set('pet_fee')} />
              <span className="hint">Charged once per pet for the whole stay</span>
            </label>
            <label>Extra person fee ($ per person, per night)
              <input type="number" step="0.01" min="0" value={f.extra_person_fee} onChange={set('extra_person_fee')} />
              <span className="hint">Charged for each guest above the included number, every night</span>
            </label>
            <label>Guests included in room rate
              <input type="number" min="1" max="10" value={f.included_guests} onChange={set('included_guests')} />
              <span className="hint">Example: 2 means the 3rd guest is an extra person</span>
            </label>
            <label>Late fee ($ per occurrence)
              <input type="number" step="0.01" min="0" value={f.late_fee} onChange={set('late_fee')} />
              <span className="hint">Offered at check-in and at checkout when the guest leaves after checkout time</span>
            </label>
            <div className="span-2 form-actions">
              <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save charges'}</button>
            </div>
          </div>
        </form>
      )}
    </>
  )
}
