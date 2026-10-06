import api from './api'

export const DL_SIDES = [['DL_FRONT', 'Front'], ['DL_BACK', 'Back']]

/** Resize an image file / blob to a JPG of at most `max` px on the long side. */
export async function compressImage(file, max = 1600, quality = 0.82) {
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image()
      i.onload = () => resolve(i)
      i.onerror = () => reject(new Error('This file is not a photo.'))
      i.src = url
    })
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(img.naturalWidth * scale)
    canvas.height = Math.round(img.naturalHeight * scale)
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality))
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Upload one photo. stay / guest optional (none = waits until the check-in is saved). */
export async function uploadPhoto(file, { kind, stay, guest, via, issue }) {
  const blob = await compressImage(file)
  const fd = new FormData()
  fd.append('image', blob, 'photo.jpg')
  fd.append('kind', kind)
  fd.append('via', via || 'FILE')
  if (stay) fd.append('stay', stay)
  if (guest) fd.append('guest', guest)
  if (issue) fd.append('issue', issue)
  const { data } = await api.post('/photos/', fd)
  return data
}
