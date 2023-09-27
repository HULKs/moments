use std::{net::SocketAddr, path::PathBuf, sync::Arc};

use anyhow::{Context, Result};
use axum::{
    extract::DefaultBodyLimit,
    routing::{get, post},
    Router, Server,
};
use clap::Parser;
use index::{collect_images, Indexer};
use log::info;
use tokio::{
    fs::{create_dir_all, try_exists, File},
    io::AsyncWriteExt,
};
use tower_http::services::ServeDir;
use upload::{load_and_resize, upload_image};
use websocket::handle_websocket_upgrade;

mod index;
mod upload;
mod websocket;

/// A simple image gallery server
#[derive(Parser)]
struct Arguments {
    /// host to listen on
    #[arg(long, default_value = "0.0.0.0")]
    host: String,
    /// port to listen on
    #[arg(long, default_value = "3000")]
    port: u16,
    /// path to directory where uploaded images are stored
    #[arg(long, default_value = "storage/")]
    storage: PathBuf,
    /// path to directory where cached images are stored
    #[arg(long, default_value = "cache/")]
    cache: PathBuf,
    /// a secret used to authenticate requests, e.g. the name of the event
    #[arg(long)]
    secret: String,
    /// Maximum size of longest edge of cached images in pixels
    #[arg(long, default_value = "1000")]
    max_cached_image_size: u32,
    /// JPEG image quality
    #[arg(long, default_value = "80")]
    jpeg_image_quality: u8,
    /// the maximum size of a request body in bytes, which results in the maximum size an uploaded
    /// image can have
    #[arg(long, default_value = "16777216")]
    max_request_body_size: usize,
}

#[derive(Clone)]
pub struct Configuration {
    storage: PathBuf,
    cache: PathBuf,
    max_cached_image_size: u32,
    jpeg_image_quality: u8,
}

#[tokio::main]
async fn main() -> Result<()> {
    env_logger::init();

    let arguments = Arguments::parse();
    let configuration = Arc::new(Configuration {
        storage: arguments.storage,
        cache: arguments.cache,
        max_cached_image_size: arguments.max_cached_image_size,
        jpeg_image_quality: arguments.jpeg_image_quality,
    });

    create_dir_all(&configuration.storage)
        .await
        .context("failed to create storage directory")?;
    create_dir_all(&configuration.cache)
        .await
        .context("failed to create cache directory")?;

    info!("Populating cache...");
    populate_cache(&configuration)
        .await
        .context("failed to populate cache")?;

    let indexer = Arc::new(Indexer::spawn(&configuration.cache).await?);

    let app = Router::new()
        .nest_service(
            &format!("/images/{}", arguments.secret),
            ServeDir::new(&configuration.cache),
        )
        .route(
            &format!("/index/{}", arguments.secret),
            get(handle_websocket_upgrade).with_state(indexer),
        )
        .route(
            &format!("/upload/{}", arguments.secret),
            post(upload_image)
                .with_state(configuration.clone())
                .layer(DefaultBodyLimit::max(arguments.max_request_body_size)),
        )
        .fallback_service(ServeDir::new("frontend/"));

    let address: SocketAddr = format!("{}:{}", arguments.host, arguments.port)
        .parse()
        .context("failed to parse host and port")?;

    info!("Serving at {address}");
    Server::bind(&address)
        .serve(app.into_make_service())
        .await
        .context("failed to start server")?;
    Ok(())
}

async fn populate_cache(configuration: &Configuration) -> Result<()> {
    let images = collect_images(&configuration.storage)
        .await
        .context("failed to index storage")?;
    for image in images {
        let storage_path = configuration.storage.join(&image.path);
        let cache_path = configuration.cache.join(&image.path);
        if let Ok(true) = try_exists(&cache_path).await {
            continue;
        }
        let resized_image = load_and_resize(
            &storage_path,
            configuration.max_cached_image_size,
            configuration.jpeg_image_quality,
        )
        .await
        .context("failed to resize image")?;

        File::create(&cache_path)
            .await?
            .write_all(&resized_image)
            .await?;
    }
    Ok(())
}
