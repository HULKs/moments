use std::{io::Cursor, path::Path};

use image::{
    codecs::jpeg::JpegEncoder,
    error::{UnsupportedError, UnsupportedErrorKind},
    imageops::FilterType,
    ImageError, ImageFormat,
};
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
    let orientation = extract_exif_orientation(&buffer);
    let image = image::load_from_memory(&buffer)?;
    let resized_image = image.resize(max_size, max_size, FilterType::Lanczos3);

    let transformed_image = match orientation {
        0 | 1 => resized_image,
        2 => resized_image.fliph(),
        3 => resized_image.rotate180(),
        4 => resized_image.flipv(),
        5 => resized_image.rotate90().fliph(),
        6 => resized_image.rotate90(),
        7 => resized_image.rotate270().fliph(),
        8 => resized_image.rotate270(),
        _ => {
            return Err(ImageError::Unsupported(
                UnsupportedError::from_format_and_kind(
                    ImageFormat::Jpeg.into(),
                    UnsupportedErrorKind::GenericFeature(format!(
                        "unsupported exif orientation: {}",
                        orientation
                    )),
                ),
            ));
        }
    };

    let mut encoded_image = Vec::with_capacity(buffer.len());
    let encoder = JpegEncoder::new_with_quality(&mut encoded_image, jpeg_image_quality);
    transformed_image.write_with_encoder(encoder)?;
    Ok(encoded_image)
}

fn extract_exif_orientation(buffer: &Vec<u8>) -> u32 {
    let exifreader = exif::Reader::new();
    exifreader
        .read_from_container(&mut Cursor::new(buffer))
        .ok()
        .and_then(|exif| {
            exif.get_field(exif::Tag::Orientation, exif::In::PRIMARY)
                .and_then(|field| field.value.get_uint(0))
        })
        .unwrap_or(1)
}
