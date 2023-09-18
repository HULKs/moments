use std::{path::PathBuf, sync::Arc};

use anyhow::{Context, Result};
use axum::{
    extract::{
        ws::{Message, WebSocket},
        DefaultBodyLimit, State, WebSocketUpgrade,
    },
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Router, Server,
};
use axum_typed_multipart::{FieldData, TryFromMultipart, TypedMultipart};
use clap::Parser;
use index::Indexer;
use tempfile::NamedTempFile;
use time::{format_description::parse, OffsetDateTime};
use tokio::fs::copy;
use tower_http::services::ServeDir;

mod index;

#[derive(Parser)]
struct Arguments {
    #[arg(long, default_value = "0.0.0.0")]
    host: String,
    #[arg(long, default_value = "3000")]
    port: u16,
    #[arg(long, default_value = "storage/")]
    storage: PathBuf,
    // e.g., "foo"
    #[arg(long)]
    secret: String,
}

#[derive(Clone)]
struct Configuration {
    storage: PathBuf,
}

#[tokio::main]
async fn main() -> Result<()> {
    let arguments = Arguments::parse();
    let configuration = Arc::new(Configuration {
        storage: arguments.storage,
    });
    let indexer = Arc::new(Indexer::spawn(&configuration.storage).await?);

    let images = Router::new()
        .route("/index", get(handle_websocket_upgrade).with_state(indexer))
        .fallback_service(ServeDir::new(&configuration.storage));
    let app = Router::new()
        .nest(&format!("/images/{}", arguments.secret), images)
        .route(
            &format!("/upload/{}", arguments.secret),
            post(upload_image)
                .with_state(configuration.clone())
                .layer(DefaultBodyLimit::max(16 * 1024 * 1024)),
        )
        .fallback_service(ServeDir::new("frontend/"));

    Server::bind(
        &format!("{}:{}", arguments.host, arguments.port)
            .parse()
            .context("failed to parse host and port")?,
    )
    .serve(app.into_make_service())
    .await
    .context("failed to start server")?;
    Ok(())
}

async fn handle_websocket_upgrade(
    upgrade: WebSocketUpgrade,
    State(indexer): State<Arc<Indexer>>,
) -> impl IntoResponse {
    upgrade.on_upgrade(move |socket| handle_websocket(socket, indexer))
}

async fn handle_websocket(mut socket: WebSocket, indexer: Arc<Indexer>) {
    let mut updates = indexer.updates.resubscribe();
    let index = indexer.index().await;
    let message = Message::Text(serde_json::to_string(&index).unwrap());
    socket.send(message).await.unwrap();
    while let Ok(update) = updates.recv().await {
        let message = Message::Text(serde_json::to_string(&update).unwrap());
        socket.send(message).await.unwrap();
    }
}

#[derive(TryFromMultipart)]
struct UploadImageRequest {
    #[form_data(limit = "unlimited")]
    image: FieldData<NamedTempFile>,
}

// test with
// curl --location "http://localhost:3000/upload/rohow2023" --form "image=@/my_picture.jpg"
async fn upload_image(
    State(configuration): State<Arc<Configuration>>,
    TypedMultipart(UploadImageRequest { image }): TypedMultipart<UploadImageRequest>,
) -> Result<(), (StatusCode, String)> {
    let format = parse("[year][month][day]T[hour][minute][second]Z").unwrap();
    let timestamp = OffsetDateTime::now_utc().format(&format).unwrap();
    let file_name = image
        .metadata
        .file_name
        .map(|file_name| format!("{timestamp}_{file_name}"))
        .unwrap_or(timestamp);
    let path = configuration.storage.join(file_name);
    copy(image.contents.path(), &path)
        .await
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    Ok(())
}
