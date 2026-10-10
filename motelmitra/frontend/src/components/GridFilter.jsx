import { useEffect, useRef, useState } from 'react'

/**
 * "Filter rows…" box for a grid. Put it right before the grid (or the div around it):
 *   <GridFilter />
 *   <div className="table-wrap"><table>…</table></div>
 * Typing hides the rows that do not contain the words (any column, any order).
 * Grids made of one <tbody> per group (the room sheet) are filtered group by group.
 * Totals in the footer stay for all rows; the box says so while a filter is on.
 */
export default function GridFilter({ placeholder = 'Filter rows…' }) {
  const ref = useRef(null)
  const [q, setQ] = useState('')
  const [count, setCount] = useState({ shown: 0, total: 0 })

  useEffect(() => {
    const box = ref.current
    let el = box?.nextElementSibling
    while (el && el.tagName !== 'TABLE' && !el.querySelector('table')) el = el.nextElementSibling
    const table = el && (el.tagName === 'TABLE' ? el : el.querySelector('table'))
    if (!table) return undefined

    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
    let frame = 0
    const apply = () => {
      frame = 0
      const units = table.tBodies.length > 1 ? [...table.tBodies] : [...(table.tBodies[0]?.rows || [])]
      let shown = 0
      units.forEach((u) => {
        const text = u.textContent.toLowerCase()
        const hit = words.every((w) => text.includes(w))
        u.style.display = hit ? '' : 'none'
        if (hit) shown += 1
      })
      table.classList.toggle('gf-active', words.length > 0)
      setCount((c) => (c.shown === shown && c.total === units.length ? c : { shown, total: units.length }))
    }
    apply()
    // rows change when the page reloads data: filter them again
    const obs = new MutationObserver(() => { if (!frame) frame = requestAnimationFrame(apply) })
    obs.observe(table, { childList: true, subtree: true, characterData: true })
    return () => {
      obs.disconnect()
      if (frame) cancelAnimationFrame(frame)
      const units = table.tBodies.length > 1 ? [...table.tBodies] : [...(table.tBodies[0]?.rows || [])]
      units.forEach((u) => { u.style.display = '' })
      table.classList.remove('gf-active')
    }
  }, [q])

  return (
    <div className="grid-filter no-print" ref={ref}>
      <span className="gf-icon" aria-hidden>🔍</span>
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} aria-label="Filter rows" />
      {q && (
        <span className="tiny muted">
          {count.shown} of {count.total} · <button type="button" className="link-btn" onClick={() => setQ('')}>Clear</button>
          {' '}· totals below are for all rows
        </span>
      )}
    </div>
  )
}
