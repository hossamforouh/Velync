class VelyncError extends Error {
  constructor(message, code = 500) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
  }
}

class ConnectionError extends VelyncError {
  constructor(message) {
    super(message, 401);
  }
}

class SyncError extends VelyncError {
  constructor(message) {
    super(message, 500);
  }
}

class AuthError extends VelyncError {
  constructor(message) {
    super(message, 401);
  }
}

class ValidationError extends VelyncError {
  constructor(message) {
    super(message, 400);
  }
}

module.exports = { VelyncError, ConnectionError, SyncError, AuthError, ValidationError };
