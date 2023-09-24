use std::sync::Arc;

use axum::{
    extract::{
        ws::{Message, WebSocket},
        State, WebSocketUpgrade,
    },
    response::IntoResponse,
};

use crate::index::Indexer;

pub async fn handle_websocket_upgrade(
    upgrade: WebSocketUpgrade,
    State(indexer): State<Arc<Indexer>>,
) -> impl IntoResponse {
    upgrade.on_upgrade(move |socket| handle_websocket(socket, indexer))
}

pub async fn handle_websocket(mut socket: WebSocket, indexer: Arc<Indexer>) {
    let mut updates = indexer.updates.resubscribe();
    let index = indexer.index().await;
    let message = Message::Text(serde_json::to_string(&index).unwrap());
    socket.send(message).await.unwrap();
    while let Ok(update) = updates.recv().await {
        let message = Message::Text(serde_json::to_string(&update).unwrap());
        socket.send(message).await.unwrap();
    }
}
