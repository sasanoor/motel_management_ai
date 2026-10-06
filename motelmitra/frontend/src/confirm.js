// App-styled confirm box (replaces the browser's window.confirm, which shows "localhost says").
//   if (!(await confirmBox({ title: 'Delete expense?', message: '...', details: [['Amount', '$22.00']] }))) return
// Options: title, message (new lines kept), details [[label, value], ...],
//          confirmText (default "Delete" for danger, "OK" otherwise), cancelText, tone 'danger' | 'primary'.
// The box itself is drawn by <ConfirmHost /> (mounted once in main.jsx).
let show = null

export function setConfirmHost(fn) { show = fn }

export function confirmBox(opts) {
  const o = typeof opts === 'string' ? { message: opts } : opts
  return new Promise((resolve) => {
    if (!show) { resolve(window.confirm([o.title, o.message].filter(Boolean).join('\n\n'))); return }
    show({ tone: 'danger', ...o, resolve })
  })
}
