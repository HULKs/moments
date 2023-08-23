use std::{
    fs::File,
    io::{BufWriter, Write},
    path::PathBuf,
};

use anyhow::{Context, Result};
use axum::{
    extract::{Multipart, Path, State},
    routing::post,
    Router, Server,
};
use clap::Parser;
use tower_http::services::ServeDir;

#[derive(Parser)]
struct Arguments {
    #[arg(long, default_value = "0.0.0.0")]
    host: String,
    #[arg(long, default_value = "3000")]
    port: u16,
    #[arg(long, default_value = "storage/")]
    storage: String,
}

#[tokio::main]
async fn main() -> Result<()> {
    let arguments = Arguments::parse();
    let storage = PathBuf::from(arguments.storage);

    let app = Router::new()
        .nest_service("/", ServeDir::new("assets/"))
        .nest_service("/image", ServeDir::new(&storage))
        .route("/upload/:event", post(upload_image).with_state(storage));

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
// curl --location --request POST 'http://localhost:3000/upload/rohow2023' \
//      --header 'Content-Type: multipart/form-data' \
//      --form '0003.jpg=@/my_picture.jpg'
async fn upload_image(
    State(storage): State<PathBuf>,
    Path(path): Path<PathBuf>,
    mut form_data: Multipart,
) {
    while let Some(field) = form_data.next_field().await.unwrap() {
        let name = field.name().unwrap().to_string();
        let data = field.bytes().await.unwrap();

        let destination = storage.join(&path).join(&name);
        println!("Storing {name} in {}", destination.display());

        let file = File::create(destination).unwrap();
        let mut writer = BufWriter::new(file);
        writer.write_all(&data).unwrap();
    }
}
