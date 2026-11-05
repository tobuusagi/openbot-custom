/** Durable chat request receipts and events for an explicitly authorized Host transport. */
export const HOST_CHAT_RECOVERY_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS host_chat_recovery_scopes (
    scope_key TEXT PRIMARY KEY,
    scope_json TEXT NOT NULL CHECK(json_valid(scope_json)),
    last_sequence INTEGER NOT NULL CHECK(last_sequence >= 0)
  );
  CREATE TABLE IF NOT EXISTS host_chat_recovery_messages (
    scope_key TEXT NOT NULL REFERENCES host_chat_recovery_scopes(scope_key) ON DELETE CASCADE,
    request_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    content TEXT NOT NULL,
    accepted_at TEXT NOT NULL,
    event_sequence INTEGER NOT NULL CHECK(event_sequence > 0),
    PRIMARY KEY(scope_key, request_id),
    UNIQUE(scope_key, message_id),
    UNIQUE(scope_key, event_sequence)
  );
  CREATE TABLE IF NOT EXISTS host_chat_recovery_events (
    scope_key TEXT NOT NULL REFERENCES host_chat_recovery_scopes(scope_key) ON DELETE CASCADE,
    sequence INTEGER NOT NULL CHECK(sequence > 0),
    message_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK(event_type = 'chat-message-accepted'),
    payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
    occurred_at TEXT NOT NULL,
    PRIMARY KEY(scope_key, sequence),
    UNIQUE(scope_key, message_id),
    FOREIGN KEY(scope_key, request_id)
      REFERENCES host_chat_recovery_messages(scope_key, request_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS host_chat_recovery_message_targets
    ON host_chat_recovery_messages(scope_key, agent_id, thread_id);
`;

export const HOST_CHAT_DELIVERY_SCHEMA_SQL = `
  CREATE TABLE host_chat_delivery_ledger (
    scope_key TEXT NOT NULL,
    request_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    message_id TEXT NOT NULL,
    delivery_id TEXT NOT NULL,
    queued_at TEXT NOT NULL,
    receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
    PRIMARY KEY(scope_key, request_id),
    UNIQUE(message_id),
    UNIQUE(delivery_id)
  );
`;
