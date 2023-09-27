use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use axum_typed_multipart::{FieldData, TryFromMultipart, TypedMultipart};
use image::{codecs::jpeg::JpegEncoder, imageops::FilterType, ImageError};
use tempfile::NamedTempFile;
use thiserror::Error;
use time::{format_description::parse, OffsetDateTime};
use tokio::{
    fs::{copy, try_exists, File},
    io::{AsyncReadExt, AsyncWriteExt, BufReader},
    task::{spawn_blocking, JoinError},
};

use crate::Configuration;

#[derive(TryFromMultipart)]
pub struct UploadImageRequest {
    #[form_data(limit = "unlimited")]
    image: FieldData<NamedTempFile>,
}

pub async fn upload_image(
    State(configuration): State<Arc<Configuration>>,
    TypedMultipart(UploadImageRequest { image }): TypedMultipart<UploadImageRequest>,
) -> Result<(), UploadError> {
    let format = parse("[year][month][day]T[hour][minute][second]Z").unwrap();
    let timestamp = OffsetDateTime::now_utc().format(&format).unwrap();
    let file_name = image
        .metadata
        .file_name
        .map(|file_name| format!("{timestamp}_{file_name}"))
        .unwrap_or(timestamp);
    let storage_path = configuration.storage.join(&file_name);
    let cache_path = configuration.cache.join(&file_name);
    let uploaded_image = &image.contents.path();

    let resized_image = load_and_resize(
        uploaded_image,
        configuration.max_cached_image_size,
        configuration.jpeg_image_quality,
    )
    .await?;

    File::create(&cache_path)
        .await?
        .write_all(&resized_image)
        .await?;

    copy(uploaded_image, &storage_path).await?;
    Ok(())
}

#[derive(Error, Debug)]
pub enum UploadError {
    #[error("{file} not found: {error}")]
    NotFound { file: PathBuf, error: String },
    #[error("failed to perform io")]
    Io(#[from] std::io::Error),
    #[error("image error")]
    Image(#[from] ImageError),
    #[error("join error")]
    Join(#[from] JoinError),
}

impl IntoResponse for UploadError {
    fn into_response(self) -> Response {
        match self {
            UploadError::NotFound { file, error } => (
                StatusCode::NOT_FOUND,
                format!("{}: {}", file.display(), error),
            )
                .into_response(),
            UploadError::Io(error) => {
                (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response()
            }
            UploadError::Image(error) => {
                (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response()
            }
            UploadError::Join(error) => {
                (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response()
            }
        }
    }
}

pub async fn load_and_resize(
    image: impl AsRef<Path>,
    max_size: u32,
    jpeg_image_quality: u8,
) -> Result<Vec<u8>, UploadError> {
    if let Err(error) = try_exists(&image).await {
        return Err(UploadError::NotFound {
            file: image.as_ref().to_path_buf(),
            error: error.to_string(),
        });
    }

    let file = File::open(&image).await?;
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
