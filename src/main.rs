use std::{path::PathBuf, sync::Arc};

use anyhow::{Context, Result};
use axum::{
    extract::{
        ws::{Message, WebSocket},
        Multipart, State, WebSocketUpgrade,
    },
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Router, Server,
};
use clap::Parser;
use index::Indexer;
use time::{format_description::parse, OffsetDateTime};
use tokio::{
    fs::File,
    io::{AsyncWriteExt, BufWriter},
};
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
            post(upload_image).with_state(configuration.clone()),
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

// test with
// curl --location "http://localhost:3000/upload/rohow2023" --form "image=@/my_picture.jpg"
async fn upload_image(
    State(configuration): State<Arc<Configuration>>,
    mut form_data: Multipart,
) -> Result<(), (StatusCode, String)> {
    while let Some(mut field) = form_data
        .next_field()
        .await
        .map_err(|error| (StatusCode::BAD_REQUEST, error.to_string()))?
    {
        let name = field
            .name()
            .ok_or_else(|| (StatusCode::BAD_REQUEST, "Missing field name".to_string()))?;
        match name {
            "image" => {
                let format = parse("[year][month][day]T[hour][minute][second]Z").unwrap();
                let timestamp = OffsetDateTime::now_utc().format(&format).unwrap();
                let file_name = if let Some(file_name) = field.file_name() {
                    format!("{timestamp}_{file_name}")
                } else {
                    timestamp
                };
                let path = configuration.storage.join(file_name);
                let file = File::create(&path)
                    .await
                    .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
                let mut file = BufWriter::new(file);
                while let Some(mut chunk) = field
                    .chunk()
                    .await
                    .map_err(|error| (StatusCode::BAD_REQUEST, error.to_string()))?
                {
                    file.write_all_buf(&mut chunk)
                        .await
                        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
                }
            }
            _ => {
                eprintln!("ignoring field {name}");
            }
        }
    }
    Ok(())
}
