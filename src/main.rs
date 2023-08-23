use anyhow::Result;
use axum::{Router, Server};
use tower_http::services::ServeDir;

#[tokio::main]
async fn main() -> Result<()> {
    let app = Router::new().nest_service("/", ServeDir::new("assets/"));

    Server::bind(&"0.0.0.0:3000".parse()?)
        .serve(app.into_make_service())
        .await?;
    Ok(())
}
