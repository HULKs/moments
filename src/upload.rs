use std::sync::Arc;

use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use axum_typed_multipart::{FieldData, TryFromMultipart, TypedMultipart};
use image::ImageError;
use tempfile::NamedTempFile;
use thiserror::Error;
use time::{format_description::parse, OffsetDateTime};
use tokio::fs::copy;

use crate::{cache::cache_image, Configuration};

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

    cache_image(
        &uploaded_image,
        &cache_path,
        configuration.max_cached_image_size,
        configuration.jpeg_image_quality,
    )
    .await?;

    copy(uploaded_image, &storage_path)
        .await
        .map_err(ImageError::from)?;
    Ok(())
}

#[derive(Debug, Error)]
#[error(transparent)]
pub struct UploadError(#[from] ImageError);

impl IntoResponse for UploadError {
    fn into_response(self) -> Response {
        (StatusCode::INTERNAL_SERVER_ERROR, self.0.to_string()).into_response()
    }
}
