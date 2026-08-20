/** npm is a .cmd launcher on Windows and an executable on POSIX systems. */
export const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
