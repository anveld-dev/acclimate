//! Process ownership and worker lifecycle used by the readiness probe and shutdown.
use crate::AppState;
use axum::{Json, extract::State, http::StatusCode};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tokio::sync::{Notify, RwLock, RwLockReadGuard};

pub const READINESS_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(1);
// HTTP handlers already have a 30 second deadline. Leave time for their cleanup.
pub const SHUTDOWN_GRACE: std::time::Duration = std::time::Duration::from_secs(35);

#[derive(Default)]
pub struct RuntimeStatus {
    owner: AtomicBool,
    initialized: AtomicBool,
    worker_live: AtomicBool,
    draining: AtomicBool,
    changed: Notify,
    claims: RwLock<()>,
}
impl RuntimeStatus {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn ownership_acquired(&self) {
        self.owner.store(true, Ordering::SeqCst);
    }
    pub fn ownership_uncertain(&self) {
        self.owner.store(false, Ordering::SeqCst);
    }
    pub fn ownership_lost(&self) {
        self.ownership_uncertain();
        self.begin_draining();
    }
    pub fn mark_initialized(&self) {
        self.initialized.store(true, Ordering::SeqCst);
    }
    pub fn is_draining(&self) -> bool {
        self.draining.load(Ordering::SeqCst)
    }
    pub fn begin_draining(&self) {
        self.draining.store(true, Ordering::SeqCst);
        self.changed.notify_waiters();
    }
    pub fn is_ready(&self) -> bool {
        self.owner.load(Ordering::SeqCst)
            && self.initialized.load(Ordering::SeqCst)
            && self.worker_live.load(Ordering::SeqCst)
            && !self.is_draining()
    }
    pub fn worker_started(self: &Arc<Self>) -> WorkerLifetime {
        self.worker_live.store(true, Ordering::SeqCst);
        self.changed.notify_waiters();
        WorkerLifetime(self.clone())
    }
    pub async fn wait_for_worker(&self) {
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if self.worker_live.load(Ordering::SeqCst) {
                return;
            }
            changed.await;
        }
    }
    pub async fn wait_for_drain(&self) {
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if self.is_draining() {
                return;
            }
            changed.await;
        }
    }
    // Hold only while claiming work. The coordinator
    // crosses the write barrier after setting draining to settle earlier claims.
    pub async fn claim_permit(&self) -> Option<RwLockReadGuard<'_, ()>> {
        let permit = self.claims.read().await;
        if self.is_draining() || !self.owner.load(Ordering::SeqCst) {
            None
        } else {
            Some(permit)
        }
    }
    pub async fn settle_claims(&self) {
        drop(self.claims.write().await);
    }
}

pub struct WorkerLifetime(Arc<RuntimeStatus>);
impl Drop for WorkerLifetime {
    fn drop(&mut self) {
        self.0.worker_live.store(false, Ordering::SeqCst);
        self.0.changed.notify_waiters();
    }
}

pub async fn readiness(State(state): State<AppState>) -> (StatusCode, Json<Value>) {
    let ready = state.runtime.is_ready()
        && matches!(
            tokio::time::timeout(
                READINESS_TIMEOUT,
                sqlx::query_scalar::<_, i32>("SELECT 1").fetch_one(&state.db)
            )
            .await,
            Ok(Ok(1))
        )
        && state.runtime.is_ready();
    if ready {
        (StatusCode::OK, Json(json!({"ready": true})))
    } else {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"ready": false})),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn readiness_requires_owner_initialization_and_live_worker() {
        let status = Arc::new(RuntimeStatus::new());
        assert!(!status.is_ready());
        status.ownership_acquired();
        status.mark_initialized();
        assert!(!status.is_ready());
        let worker = status.worker_started();
        status.wait_for_worker().await;
        assert!(status.is_ready());
        drop(worker);
        assert!(!status.is_ready());
    }
    #[tokio::test]
    async fn draining_withdraws_readiness_and_prevents_further_claims() {
        let status = Arc::new(RuntimeStatus::new());
        status.ownership_acquired();
        status.mark_initialized();
        let _worker = status.worker_started();
        let permit = status.claim_permit().await.unwrap();
        status.begin_draining();
        status.wait_for_drain().await;
        assert!(!status.is_ready());
        assert!(status.claim_permit().await.is_none());
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(10), status.settle_claims())
                .await
                .is_err()
        );
        drop(permit);
        status.settle_claims().await;
    }
    #[test]
    fn lost_ownership_withdraws_readiness() {
        let status = Arc::new(RuntimeStatus::new());
        status.ownership_acquired();
        status.mark_initialized();
        let _worker = status.worker_started();
        status.ownership_lost();
        assert!(!status.is_ready());
        assert!(status.is_draining());
    }
}
