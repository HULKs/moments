use anyhow::{Context, Result};
use axum::{Router, Server};
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

    let app = Router::new()
        .nest_service("/", ServeDir::new("assets/"))
        .nest_service("/image", ServeDir::new(arguments.storage));

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
