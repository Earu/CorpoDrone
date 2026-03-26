use std::collections::HashMap;
use parking_lot::RwLock;
use serde_json::Value;
use tracing::debug;
use uuid::Uuid;

type SessionMap = HashMap<Uuid, actix_ws::Session>;

/// Broadcast hub: fan-out JSON messages to all connected WebSocket sessions.
pub struct Hub {
    sessions: RwLock<SessionMap>,
}

impl Hub {
    pub fn new() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
        }
    }

    pub fn register(&self, id: Uuid, session: actix_ws::Session) {
        self.sessions.write().insert(id, session);
        debug!("WS client registered: {id}, total={}", self.sessions.read().len());
    }

    pub fn unregister(&self, id: &Uuid) {
        self.sessions.write().remove(id);
        debug!("WS client unregistered: {id}, total={}", self.sessions.read().len());
    }

    /// Broadcast a JSON message to all connected sessions.
    /// Sessions that have closed are removed.
    pub async fn broadcast(&self, msg: Value) {
        let text = msg.to_string();
        let ids: Vec<Uuid> = self.sessions.read().keys().cloned().collect();
        let mut dead = Vec::new();

        for id in ids {
            let session = {
                let guard = self.sessions.read();
                guard.get(&id).cloned()
            };
            if let Some(mut sess) = session {
                if sess.text(text.clone()).await.is_err() {
                    dead.push(id);
                }
            }
        }

        if !dead.is_empty() {
            let mut guard = self.sessions.write();
            for id in dead {
                guard.remove(&id);
            }
        }
    }

    pub fn session_count(&self) -> usize {
        self.sessions.read().len()
    }
}
