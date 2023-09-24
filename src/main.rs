use std::{path::PathBuf, sync::Arc};

use anyhow::{Context, Result};
use axum::{
    extract::DefaultBodyLimit,
    routing::{get, post},
    Router, Server,
};
use clap::Parser;
use images::cache_and_serve;
use index::Indexer;
use tokio::fs::create_dir_all;
use tower_http::services::ServeDir;
use upload::upload_image;
use websocket::handle_websocket_upgrade;

mod images;
mod index;
mod upload;
mod websocket;

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
pub struct Configuration {
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
