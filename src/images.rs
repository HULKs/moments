use std::{
    path::{self, PathBuf},
    sync::Arc,
};

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use image::{codecs::jpeg::JpegEncoder, imageops::FilterType, ImageError};
use thiserror::Error;
use tokio::{
    fs::{create_dir_all, try_exists, File},
    io::{AsyncReadExt, AsyncWriteExt, BufReader},
    task::{spawn_blocking, JoinError},
};

use crate::Configuration;

pub async fn serve_and_cache(
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

    let image = load_and_resize(
        &file_path,
        &configuration.storage,
        configuration.max_cached_image_size,
        configuration.jpeg_image_quality,
    )
    .await?;

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
pub enum ServeError {
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
    max_size: u32,
    jpeg_image_quality: u8,
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
        let resized_image = image.resize(max_size, max_size, FilterType::Lanczos3);
        let mut encoded_image = Vec::with_capacity(buffer.len());
        let encoder = JpegEncoder::new_with_quality(&mut encoded_image, jpeg_image_quality);
        resized_image.write_with_encoder(encoder)?;
        Ok(encoded_image)
    })
    .await??;
    Ok(encoded_image)
}
