const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[process.env.LOG_LEVEL] || LEVELS.info;

function log(level, domain, message, data = null) {
  if (LEVELS[level] === undefined || LEVELS[level] < currentLevel) return;
  const entry = { level, ts: new Date().toISOString(), domain, msg: message };
  if (data) entry.data = data;
  console.log(JSON.stringify(entry));
}

const logger = {
  debug: (domain, msg, data) => log('debug', domain, msg, data),
  info: (domain, msg, data) => log('info', domain, msg, data),
  warn: (domain, msg, data) => log('warn', domain, msg, data),
  error: (domain, msg, data) => log('error', domain, msg, data),
};

module.exports = logger;
