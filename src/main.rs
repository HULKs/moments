use std::{
    path::{self, PathBuf},
    sync::Arc,
};

use anyhow::{Context, Result};
use axum::{
    extract::{
        ws::{Message, WebSocket},
        DefaultBodyLimit, Path, State, WebSocketUpgrade,
    },
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Router, Server,
};
use axum_typed_multipart::{FieldData, TryFromMultipart, TypedMultipart};
use clap::Parser;
use image::{codecs::jpeg::JpegEncoder, imageops::FilterType, ImageError};
use index::Indexer;
use tempfile::NamedTempFile;
use thiserror::Error;
use time::{format_description::parse, OffsetDateTime};
use tokio::{
    fs::{copy, create_dir_all, try_exists, File},
    io::{AsyncReadExt, AsyncWriteExt, BufReader},
    task::{spawn_blocking, JoinError},
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
    #[arg(long, default_value = "cache/")]
    cache: PathBuf,
    // e.g., "foo"
    #[arg(long)]
    secret: String,
}

#[derive(Clone)]
struct Configuration {
    storage: PathBuf,
    cache: PathBuf,
}

#[tokio::main]
async fn main() -> Result<()> {
    let arguments = Arguments::parse();
    let configuration = Arc::new(Configuration {
        storage: arguments.storage,
        cache: arguments.cache,
    });
    create_dir_all(&configuration.storage)
        .await
        .context("failed to create storage directory")?;
    create_dir_all(&configuration.cache)
        .await
        .context("failed to create cache directory")?;
    let indexer = Arc::new(Indexer::spawn(&configuration.storage).await?);

    let app = Router::new()
        .route_service(
            &format!("/images/{}/*file_name", arguments.secret),
            get(cache_and_serve).with_state(configuration.clone()),
        )
        .route(
            &format!("/index/{}", arguments.secret),
            get(handle_websocket_upgrade).with_state(indexer),
        )
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

async fn cache_and_serve(
    Path(file_path): Path<String>,
    State(configuration): State<Arc<Configuration>>,
) -> Result<Vec<u8>, ServeError> {
    let cache_path = configuration.cache.join(&file_path);

    if let Ok(true) = try_exists(&cache_path).await {
        let file = File::open(&cache_path).await.unwrap();
        let mut buffer = Vec::with_capacity(file.metadata().await.unwrap().len() as usize);
        BufReader::new(file).read_to_end(&mut buffer).await.unwrap();
        return Ok(buffer);
    }

    let image = load_and_resize(&file_path, &configuration.storage).await?;

    create_dir_all(cache_path.parent().unwrap()).await?;
    File::create(&cache_path)
        .await
        .unwrap()
        .write_all(&image)
        .await
        .unwrap();

    Ok(image)
}

#[derive(Error, Debug)]
enum ServeError {
    #[error("{file} not found: {error}")]
    NotFound { file: PathBuf, error: String },
    #[error("failed to read file")]
    Io(#[from] std::io::Error),
    #[error("image error")]
    Image(#[from] ImageError),
    #[error("join error")]
    Join(#[from] JoinError),
}

impl IntoResponse for ServeError {
    fn into_response(self) -> Response {
        match self {
            ServeError::NotFound { file, error } => (
                StatusCode::NOT_FOUND,
                format!("{}: {}", file.display(), error),
            )
                .into_response(),
            ServeError::Io(error) => {
                (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response()
            }
            ServeError::Image(error) => {
                (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response()
            }
            ServeError::Join(error) => {
                (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response()
            }
        }
    }
}

async fn load_and_resize(
    file_path: &str,
    storage: impl AsRef<path::Path>,
) -> Result<Vec<u8>, ServeError> {
    let storage_path = storage.as_ref().to_owned().join(file_path);

    if let Err(error) = try_exists(&storage_path).await {
        return Err(ServeError::NotFound {
            file: storage_path,
            error: error.to_string(),
        });
    }

    let file = File::open(&storage_path).await?;
    let mut buffer = Vec::with_capacity(file.metadata().await?.len() as usize);
    BufReader::new(file).read_to_end(&mut buffer).await?;

    let encoded_image = spawn_blocking(move || -> Result<_, ImageError> {
        let image = image::load_from_memory(&buffer)?;
        let resized_image = image.resize(1000, 1000, FilterType::Lanczos3);
        let mut encoded_image = Vec::with_capacity(buffer.len());
        let encoder = JpegEncoder::new_with_quality(&mut encoded_image, 80);
        resized_image.write_with_encoder(encoder)?;
        Ok(encoded_image)
    })
    .await??;
    Ok(encoded_image)
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
    let storage_path = configuration.storage.join(&file_name);

    copy(image.contents.path(), &storage_path)
        .await
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    Ok(())
}
