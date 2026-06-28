const { Connector } = require('./interface');

const connectorRegistry = new Map();

function register(platformId, ConnectorClass) {
  if (!(ConnectorClass.prototype instanceof Connector) && ConnectorClass !== Connector) {
    throw new Error(`Connector for "${platformId}" must extend Connector`);
  }
  connectorRegistry.set(platformId, ConnectorClass);
}

function getConnector(platformId) {
  const Cls = connectorRegistry.get(platformId);
  if (!Cls) throw new Error(`No connector registered for platform: ${platformId}`);
  return Cls;
}

function getRegisteredPlatforms() {
  return Array.from(connectorRegistry.keys());
}

module.exports = { register, getConnector, getRegisteredPlatforms, connectorRegistry };
