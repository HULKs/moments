use std::sync::Arc;

use axum::{extract::State, http::StatusCode};
use axum_typed_multipart::{FieldData, TryFromMultipart, TypedMultipart};
use tempfile::NamedTempFile;
use time::{format_description::parse, OffsetDateTime};
use tokio::fs::copy;

use crate::Configuration;

#[derive(TryFromMultipart)]
pub struct UploadImageRequest {
    #[form_data(limit = "unlimited")]
    image: FieldData<NamedTempFile>,
}

pub async fn upload_image(
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
