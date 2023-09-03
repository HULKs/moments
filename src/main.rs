use std::{
    fs::File,
    io::{BufWriter, Write},
    path::PathBuf,
    sync::Arc,
};

use anyhow::{Context, Result};
use axum::{
    extract::{Multipart, Path, State},
    routing::{get, post},
    Json, Router, Server,
};
use clap::Parser;
use index::{Index, Indexer};
use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
use tokio::sync::RwLock;
use tower_http::services::ServeDir;

mod index;

#[derive(Parser)]
struct Arguments {
    #[arg(long, default_value = "0.0.0.0")]
    host: String,
    #[arg(long, default_value = "3000")]
    port: u16,
    #[arg(long, default_value = "storage/")]
    storage: PathBuf,
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

    let app = Router::new()
        .nest_service("/", ServeDir::new("frontend/"))
        .nest_service("/images", ServeDir::new(&configuration.storage))
        .route("/index.json", get(storage_index).with_state(index.clone()))
        .route(
            "/upload",
            post(upload_image).with_state(configuration.clone()),
        );

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
// curl --location --request POST 'http://localhost:3000/upload/rohow2023' \
//      --header 'Content-Type: multipart/form-data' \
//      --form '0003.jpg=@/my_picture.jpg'
async fn upload_image(
    State(configuration): State<Arc<Configuration>>,
    Path(path): Path<PathBuf>,
    mut form_data: Multipart,
) {
    while let Some(field) = form_data.next_field().await.unwrap() {
        let name = field.name().unwrap().to_string();
        let data = field.bytes().await.unwrap();

        let destination = configuration.storage.to_path_buf().join(&path).join(&name);
        println!("Storing {name} in {}", destination.display());

        let file = File::create(destination).unwrap();
        let mut writer = BufWriter::new(file);
        writer.write_all(&data).unwrap();
    }
}

async fn storage_index(State(index): State<Arc<RwLock<Index>>>) -> Json<Index> {
    let index = index.read().await.clone();
    Json(index)
}
