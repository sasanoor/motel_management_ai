// Same VERSION file the server reads. If they differ, the server was not restarted after an update.
import raw from '../../VERSION?raw'

export const APP_VERSION = raw.trim()
