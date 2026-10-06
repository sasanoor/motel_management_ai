import { useEffect, useMemo, useRef, useState } from 'react'
import { fmtDate, money, rateFor, rateTypeInfo } from '../utils'
import { HkPill, IssueBadge } from './ui'

/**
 * Searchable room dropdown.
 * rooms: [{ id, number, room_type, default_rate, occupied, guest_name, check_out_date }]
 * Search matches room number, room type or the current guest's name.
 */
export default function RoomPicker({ rooms, value, onChange, currentRoomId, rateType = 'DAILY' }) {
  const short = rateTypeInfo(rateType).short
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [vacantOnly, setVacantOnly] = useState(false)
  const [active, setActive] = useState(0)
  const boxRef = useRef(null)
  const searchRef = useRef(null)
  const listRef = useRef(null)

  const isBusy = (r) => r.occupied && r.id !== currentRoomId
  const selected = rooms.find((r) => String(r.id) === String(value))

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return [...rooms]
      .sort((a, b) =>
        a.room_type.localeCompare(b.room_type) || a.number.localeCompare(b.number, undefined, { numeric: true }))
      .filter((r) => !vacantOnly || !(r.occupied && r.id !== currentRoomId))
      .filter((r) => !q
        || r.number.toLowerCase().includes(q)
        || r.room_type.toLowerCase().includes(q)
        || (r.guest_name || '').toLowerCase().includes(q))
      // exact / starts-with room number matches first
      .sort((a, b) => {
        if (!q) return 0
        const rank = (r) => (r.number.toLowerCase() === q ? 0 : r.number.toLowerCase().startsWith(q) ? 1 : 2)
        return rank(a) - rank(b) || a.number.localeCompare(b.number, undefined, { numeric: true })
      })
  }, [rooms, query, vacantOnly, currentRoomId])

  // close when clicking outside
  useEffect(() => {
    if (!open) return
    const onDown = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // keep the highlighted row visible
  useEffect(() => {
    listRef.current?.querySelector('.rp-option.active')?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  function openPanel(initialText = '') {
    setQuery(initialText)
    setActive(0)
    setOpen(true)
    setTimeout(() => searchRef.current?.focus(), 0)
  }

  function choose(r) {
    onChange(r)
    setOpen(false)
  }

  function onTriggerKey(e) {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPanel() }
    else if (e.key.length === 1 && /[\w\s]/.test(e.key)) { e.preventDefault(); openPanel(e.key) } // start typing to search
  }

  function onSearchKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, filtered.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); if (filtered[active]) choose(filtered[active]) }
    else if (e.key === 'Escape' || e.key === 'Tab') setOpen(false)
  }

  return (
    <div className="rp" ref={boxRef}>
      <button
        type="button"
        className={`rp-trigger ${open ? 'open' : ''}`}
        onClick={() => (open ? setOpen(false) : openPanel())}
        onKeyDown={onTriggerKey}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {selected ? (
          <span className="rp-value">
            <strong>{selected.number}</strong> · {selected.room_type} · {money(rateFor(selected, rateType))}{short}
            {isBusy(selected) && <span className="pill pill-warn ml">Occupied</span>}
            {!isBusy(selected) && <> <HkPill status={selected.hk_status} note={selected.hk_note} /></>}
            <IssueBadge count={selected.open_issues} />
          </span>
        ) : <span className="muted">Select room…</span>}
        <span className="rp-caret">▾</span>
      </button>

      {open && (
        <div className="rp-panel">
          <div className="rp-search">
            <span className="rp-icon" aria-hidden>🔍</span>
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => { setQuery(e.target.value); setActive(0) }}
              onKeyDown={onSearchKey}
              placeholder="Search room no., type or guest"
              aria-label="Search rooms"
            />
            {query && <button type="button" className="rp-clear" onClick={() => { setQuery(''); searchRef.current?.focus() }}>✕</button>}
          </div>
          <label className="rp-toggle">
            <input type="checkbox" checked={vacantOnly} onChange={(e) => { setVacantOnly(e.target.checked); setActive(0) }} />
            Vacant only
          </label>
          <div className="rp-list" role="listbox" ref={listRef}>
            {!filtered.length && <div className="rp-empty">No rooms match “{query}”.</div>}
            {filtered.map((r, i) => {
              const header = !query && (i === 0 || filtered[i - 1].room_type !== r.room_type)
              const busy = isBusy(r)
              return (
                <div key={r.id}>
                  {header && <div className="rp-group">{r.room_type}</div>}
                  <div
                    role="option"
                    aria-selected={String(r.id) === String(value)}
                    className={`rp-option ${i === active ? 'active' : ''} ${String(r.id) === String(value) ? 'selected' : ''}`}
                    onMouseEnter={() => setActive(i)}
                    onMouseDown={(e) => { e.preventDefault(); choose(r) }}
                  >
                    <span className="rp-num">{r.number}</span>
                    <span className="rp-type">{r.room_type}</span>
                    <span className="rp-status">
                      {busy
                        ? <span className="pill pill-warn">{r.guest_name} till {fmtDate(r.check_out_date)}</span>
                        : (r.hk_status && r.hk_status !== 'READY'
                          ? <HkPill status={r.hk_status} note={r.hk_note} />
                          : <span className="pill pill-green">Vacant</span>)}
                      <IssueBadge count={r.open_issues} />
                    </span>
                    <span className="rp-rate">{money(rateFor(r, rateType))}<span className="tiny muted">{short}</span></span>
                  </div>
                </div>
              )
            })}
          </div>
          <div className="rp-foot">{filtered.length} of {rooms.length} rooms · ↑↓ to move, Enter to pick</div>
        </div>
      )}
    </div>
  )
}
