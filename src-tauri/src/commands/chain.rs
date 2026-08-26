//! Tauri commands for the Proxy Chain feature: named node pools and the
//! multi-hop chains built from them (see `config::builder`'s
//! `build_pool_selectors` / `build_chain_outbounds`).

use crate::domain::{ChainHop, NodePool, PoolMode, ProxyChain};
use crate::state::AppState;
use tauri::{AppHandle, State};

/// Queue one globally debounced restart — mirrors `rules.rs::apply_running`.
/// Pool/chain edits change the generated outbounds the same way rule edits
/// do, so they need the same debounced-restart contract.
fn apply_running(app: &AppHandle) {
    crate::rule_apply::request_restart(app.clone(), Vec::new());
}

#[tauri::command]
pub fn list_pools(state: State<'_, AppState>) -> Result<Vec<NodePool>, String> {
    state
        .with_store(|store| Ok(store.pools.clone()))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_pool(
    state: State<'_, AppState>,
    name: String,
    mode: PoolMode,
) -> Result<NodePool, String> {
    state
        .with_store_mut(|store| store.create_pool(&name, mode))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_pool(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    name: String,
    mode: PoolMode,
) -> Result<NodePool, String> {
    let pool = state
        .with_store_mut(|store| store.update_pool(&id, &name, mode))
        .map_err(|e| e.to_string())?;
    // A pool's membership feeds every chain/rule that references it —
    // always worth a restart, same as editing a rule set's keyword filter.
    apply_running(&app);
    Ok(pool)
}

#[tauri::command]
pub fn delete_pool(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
    state
        .with_store_mut(|store| store.delete_pool(&id))
        .map_err(|e| e.to_string())?;
    apply_running(&app);
    Ok(())
}

#[tauri::command]
pub fn list_chains(state: State<'_, AppState>) -> Result<Vec<ProxyChain>, String> {
    state
        .with_store(|store| Ok(store.chains.clone()))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_chain(
    state: State<'_, AppState>,
    name: String,
    hops: Vec<ChainHop>,
) -> Result<ProxyChain, String> {
    state
        .with_store_mut(|store| store.create_chain(&name, hops))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_chain(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    name: String,
    hops: Vec<ChainHop>,
) -> Result<ProxyChain, String> {
    let chain = state
        .with_store_mut(|store| store.update_chain(&id, &name, hops))
        .map_err(|e| e.to_string())?;
    apply_running(&app);
    Ok(chain)
}

#[tauri::command]
pub fn delete_chain(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    state
        .with_store_mut(|store| store.delete_chain(&id))
        .map_err(|e| e.to_string())?;
    apply_running(&app);
    Ok(())
}
