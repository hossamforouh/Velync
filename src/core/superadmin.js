const config = require('./config');

function isSuperAdmin(uid) {
  if (!uid) return false;
  return config.superadminUids.includes(uid);
}

module.exports = { isSuperAdmin };
