require('./ticktick');
require('./notion');
require('./google-contacts');

const { getConnector, getRegisteredPlatforms, register } = require('./registry');

module.exports = { getConnector, getRegisteredPlatforms, register };
