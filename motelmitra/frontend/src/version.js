// From the .env file next to start_app.bat (APP_VERSION). The server reads the same file;
// if they differ, the server was not restarted after an update.
export const APP_VERSION = import.meta.env.APP_VERSION || 'dev'
