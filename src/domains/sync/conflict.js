function resolveConflict(sourceModified, destModified, sourceMapping) {
  const srcTime = new Date(sourceModified || 0).getTime();
  const destTime = new Date(destModified || 0).getTime();
  const lastSrcTime = new Date(sourceMapping?.sourceLastModified || 0).getTime();
  const lastDestTime = new Date(sourceMapping?.destLastEdited || 0).getTime();

  const sourceChanged = srcTime > lastSrcTime + 1000;
  const destChanged = destTime > lastDestTime + 15000;

  if (sourceChanged && !destChanged) return 'source_wins';
  if (!sourceChanged && destChanged) return 'dest_wins';
  if (sourceChanged && destChanged) return srcTime >= destTime ? 'source_wins' : 'dest_wins';
  return 'no_change';
}

module.exports = { resolveConflict };
