function prefix(level) {
  return `[Electron:${level}]`;
}

function log(...args) {
  console.log(prefix("info"), ...args);
}

function warn(...args) {
  console.warn(prefix("warn"), ...args);
}

function error(...args) {
  console.error(prefix("error"), ...args);
}

module.exports = { log, warn, error };

