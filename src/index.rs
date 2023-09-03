use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::SystemTime,
};

use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::{
    fs::metadata,
    spawn,
    sync::{Notify, RwLock},
};
use walkdir::WalkDir;

#[derive(Error, Debug)]
enum IndexError {
    #[error("failed to read directory")]
    WalkDir(#[from] walkdir::Error),
    #[error("failed to read metadata")]
    Metadata(#[from] std::io::Error),
}

#[derive(Default, Clone, Debug, Serialize, Deserialize)]
pub struct Index {
    images: Vec<Image>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Image {
    path: PathBuf,
    modified: SystemTime,
}

pub struct Indexer {
    notifier: Arc<Notify>,
}

impl Indexer {
    pub fn spawn(storage: impl AsRef<Path>, index: Arc<RwLock<Index>>) -> Self {
        let notifier = Arc::new(Notify::new());
        {
            let notifier = notifier.clone();
            let storage = storage.as_ref().to_path_buf();
            spawn(async move {
                loop {
                    notifier.notified().await;
                    let images = collect_images(&storage).await.unwrap();
                    index.write().await.images = images;
                }
            });
        }
        notifier.notify_one();
        Self { notifier }
    }

    pub fn notify(&self) {
        self.notifier.notify_one();
    }
}

async fn collect_images(storage: impl AsRef<Path>) -> Result<Vec<Image>, IndexError> {
    println!("indexing {}", storage.as_ref().display());
    // TODO: walkdir is not async
    let walker = WalkDir::new(storage).into_iter();
    let entries = walker
        .filter_entry(|entry| {
            entry.file_type().is_dir()
                || entry.file_type().is_file()
                    && entry
                        .path()
                        .extension()
                        .is_some_and(|extension| extension == "jpg")
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut images = Vec::with_capacity(entries.len());
    for entry in &entries {
        let path = entry.path();
        let metadata = metadata(path).await?;
        let modified = metadata.modified()?;
        images.push(Image {
            path: path.to_path_buf(),
            modified,
        });
    }
    Ok(images)
}
