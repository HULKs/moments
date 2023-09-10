use std::{path::PathBuf, sync::Arc};

use anyhow::{Context, Result};
use axum::{
    extract::{Multipart, State},
    http::StatusCode,
    routing::{get, post},
    Json, Router, Server,
};
use clap::Parser;
use index::{Index, Indexer};
use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
use time::{format_description::parse, OffsetDateTime};
use tokio::{
    fs::File,
    io::{AsyncWriteExt, BufWriter},
    sync::RwLock,
};
use tower_http::services::ServeDir;

mod index;

#[derive(Parser)]
struct Arguments {
    #[arg(long, default_value = "[::]")]
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
    let index = Arc::new(RwLock::new(Index::default()));
    let indexer = Indexer::spawn(&configuration.storage, index.clone());

    let images = Router::new()
        .route("/index.json", get(storage_index).with_state(index.clone()))
        .fallback_service(ServeDir::new(&configuration.storage));
    let app = Router::new()
        .nest(&format!("/images/{}", arguments.secret), images)
        .route(
            &format!("/upload/{}", arguments.secret),
            post(upload_image).with_state(configuration.clone()),
        )
        .fallback_service(ServeDir::new("frontend/"));

    let mut watcher = RecommendedWatcher::new(
        move |result| match result {
            Err(error) => {
                eprintln!("watch error: {error:?}");
            }
            _ => {
                indexer.notify();
            }
        },
        Config::default(),
    )?;
    // maybe debounce?
    watcher.watch(&configuration.storage, RecursiveMode::Recursive)?;

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

async fn storage_index(State(index): State<Arc<RwLock<Index>>>) -> Json<Index> {
    let index = index.read().await.clone();
    Json(index)
}
