import { uploadPhoto } from './photoUtils'

export const CATEGORIES = [
  ['PLUMBING', 'Plumbing'], ['ELECTRICAL', 'Electrical'], ['AC_HEAT', 'AC / Heat'], ['TV_WIFI', 'TV / WiFi'],
  ['FURNITURE', 'Furniture'], ['PESTS', 'Pests'], ['CLEANLINESS', 'Cleanliness'], ['OTHER', 'Other'],
]
export const PRIORITIES = [['LOW', 'Low'], ['NORMAL', 'Normal'], ['URGENT', 'Urgent']]

/** Upload picked photos to a problem. Returns how many failed. */
export async function uploadIssuePhotos(issueId, files) {
  let failed = 0
  for (const f of files) {
    try { await uploadPhoto(f, { kind: 'ISSUE', issue: issueId }) } catch { failed += 1 }
  }
  return failed
}

