const db = require('./db');

/**
 * Resolve and authorize a workspaceId for a request, mirroring the Firestore
 * rules' isWorkspaceMember() logic: the solo-workspace shortcut (uid used
 * directly as workspaceId, no workspace doc needed) plus explicit
 * owner/members checks for real shared workspaces.
 *
 * Throws if the caller isn't authorized for the requested workspace — callers
 * that trust a client-supplied workspaceId without this check are vulnerable
 * to cross-tenant writes (any authenticated user targeting another
 * workspace's data).
 *
 * @param {string} uid - requesting user's uid
 * @param {string} [requestedWorkspaceId] - workspaceId from the request body; falls back to uid
 * @returns {Promise<string>} the authorized workspaceId
 */
async function resolveAuthorizedWorkspaceId(uid, requestedWorkspaceId) {
  const wsId = requestedWorkspaceId || uid;
  if (wsId === uid) return wsId; // solo workspace — always allowed

  const wsDoc = await db.collection('workspaces').doc(wsId).get();
  if (!wsDoc.exists) {
    const err = new Error('Workspace not found');
    err.statusCode = 404;
    throw err;
  }
  const ws = wsDoc.data();
  const isMember = ws.ownerId === uid || (Array.isArray(ws.members) && ws.members.includes(uid));
  if (!isMember) {
    const err = new Error('Not authorized for this workspace');
    err.statusCode = 403;
    throw err;
  }
  return wsId;
}

module.exports = { resolveAuthorizedWorkspaceId };
