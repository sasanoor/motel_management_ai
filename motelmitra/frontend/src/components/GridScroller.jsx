import { useEffect, useRef, useState } from 'react'

/**
 * Netflix-style ‹ › buttons for every wide grid (.table-wrap), mounted once in Layout.
 * When the mouse is over a grid that is wider than the screen, tall see-through buttons appear on
 * its left / right edge. Click = slide one screen sideways. Nothing is added inside the grids
 * themselves, so every current and future grid gets it for free.
 */
const EDGE = 4 // px of slack before an edge counts as "more to see"

function measure(el) {
  const r = el.getBoundingClientRect()
  // A pinned column (e.g. the action buttons on the room sheet) stays visible: put the arrows
  // beside it, not on top of its buttons.
  const pinned = (sel) => {
    const cell = [...el.querySelectorAll(sel)].find((c) => getComputedStyle(c).position === 'sticky')
    return cell ? cell.getBoundingClientRect() : null
  }
  const lastPin = pinned('thead tr > :last-child, tbody tr:first-child > :last-child')
  const firstPin = pinned('thead tr > :first-child, tbody tr:first-child > :first-child')
  const top = Math.max(r.top, 0)
  const bottom = Math.min(r.bottom, window.innerHeight)
  return {
    left: firstPin ? firstPin.right : r.left, right: lastPin ? lastPin.left : r.right, top, height: Math.max(bottom - top, 0),
    canLeft: el.scrollLeft > EDGE,
    canRight: el.scrollLeft + el.clientWidth < el.scrollWidth - EDGE,
  }
}

export default function GridScroller() {
  const [box, setBox] = useState(null)
  const target = useRef(null)
  const hideT = useRef(null)

  useEffect(() => {
    const refresh = () => {
      const el = target.current
      if (!el || !el.isConnected) { target.current = null; setBox(null); return }
      const m = measure(el)
      setBox(m.height > 40 && (m.canLeft || m.canRight) ? m : null)
    }
    const onMove = (e) => {
      if (e.target.closest?.('.gs-btn')) { clearTimeout(hideT.current); return }
      const el = e.target.closest?.('.table-wrap')
      if (el) {
        clearTimeout(hideT.current)
        if (el !== target.current) {
          target.current?.removeEventListener('scroll', refresh)
          target.current = el
          el.addEventListener('scroll', refresh, { passive: true })
        }
        refresh()
      } else if (target.current) {
        clearTimeout(hideT.current)
        hideT.current = setTimeout(() => {
          target.current?.removeEventListener('scroll', refresh)
          target.current = null
          setBox(null)
        }, 250)
      }
    }
    const onScroll = () => target.current && refresh()
    document.addEventListener('mousemove', onMove, { passive: true })
    window.addEventListener('scroll', onScroll, { passive: true, capture: true })
    window.addEventListener('resize', onScroll)
    return () => {
      document.removeEventListener('mousemove', onMove)
      window.removeEventListener('scroll', onScroll, { capture: true })
      window.removeEventListener('resize', onScroll)
      target.current?.removeEventListener('scroll', refresh)
      clearTimeout(hideT.current)
    }
  }, [])

  if (!box) return null
  const slide = (dir) => {
    const el = target.current
    if (el) el.scrollBy({ left: dir * Math.max(el.clientWidth * 0.8, 200), behavior: 'smooth' })
  }
  const style = { top: box.top, height: box.height }
  return (
    <>
      {box.canLeft && (
        <button type="button" className="gs-btn gs-left" style={{ ...style, left: box.left }}
          aria-label="Scroll grid left" onClick={() => slide(-1)}>‹</button>
      )}
      {box.canRight && (
        <button type="button" className="gs-btn gs-right" style={{ ...style, left: box.right - 52 }}
          aria-label="Scroll grid right" onClick={() => slide(1)}>›</button>
      )}
    </>
  )
}
