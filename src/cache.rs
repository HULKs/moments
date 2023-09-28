use std::path::Path;

use image::{codecs::jpeg::JpegEncoder, imageops::FilterType, ImageError};
use tokio::{
    fs::{try_exists, File},
    io::{AsyncReadExt, AsyncWriteExt, BufReader},
    task::spawn_blocking,
};

pub async fn cache_image(
    source: impl AsRef<Path>,
    destination: impl AsRef<Path>,
    max_size: u32,
    jpeg_image_quality: u8,
) -> Result<(), ImageError> {
    if let Ok(true) = try_exists(&destination).await {
        return Ok(());
    }
    let file = File::open(&source).await?;
    let mut buffer = Vec::with_capacity(file.metadata().await?.len() as usize);
    BufReader::new(file).read_to_end(&mut buffer).await?;

    let encoded_image =
        spawn_blocking(move || load_and_resize(buffer, max_size, jpeg_image_quality))
            .await
            .unwrap()?;

    File::create(&destination)
        .await?
        .write_all(&encoded_image)
        .await?;
    Ok(())
}

fn load_and_resize(
    buffer: Vec<u8>,
    max_size: u32,
    jpeg_image_quality: u8,
) -> Result<Vec<u8>, ImageError> {
    let image = image::load_from_memory(&buffer)?;
    let resized_image = image.resize(max_size, max_size, FilterType::Lanczos3);
    let mut encoded_image = Vec::with_capacity(buffer.len());
    let encoder = JpegEncoder::new_with_quality(&mut encoded_image, jpeg_image_quality);
    resized_image.write_with_encoder(encoder)?;
    Ok(encoded_image)
}
