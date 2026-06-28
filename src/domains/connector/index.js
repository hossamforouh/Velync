require('./ticktick');
require('./notion');

const { getConnector, getRegisteredPlatforms, register } = require('./registry');

module.exports = { getConnector, getRegisteredPlatforms, register };
