use std::{
    collections::HashSet,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime},
};

use notify::RecursiveMode;
use notify_debouncer_mini::new_debouncer;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::{
    fs::metadata,
    select, spawn,
    sync::{broadcast, mpsc, oneshot, Notify},
};
use walkdir::WalkDir;

#[derive(Error, Debug)]
pub enum IndexError {
    #[error("failed to read directory")]
    WalkDir(#[from] walkdir::Error),
    #[error("failed to read metadata")]
    Metadata(#[from] std::io::Error),
    #[error("failed to watch directory")]
    Watch(#[from] notify::Error),
}

#[derive(Default, Clone, Debug, Serialize, Deserialize)]
pub struct Index {
    pub images: HashSet<Image>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Eq)]
pub struct Image {
    path: PathBuf,
    modified: SystemTime,
}

impl Hash for Image {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.path.hash(state);
    }
}

impl PartialEq for Image {
    fn eq(&self, other: &Self) -> bool {
        self.path == other.path
    }
}

pub struct Indexer {
    pub updates: broadcast::Receiver<Updates>,
    index: mpsc::Sender<oneshot::Sender<Index>>,
}

impl Indexer {
    pub async fn spawn(watch_path: impl AsRef<Path>) -> Result<Self, IndexError> {
        let watch_path = watch_path.as_ref().to_path_buf();
        let notifier = Arc::new(Notify::new());
        let mut debouncer = new_debouncer(Duration::from_secs(1), {
            let notifier = notifier.clone();
            move |result| match result {
                Ok(_) => {
                    notifier.notify_one();
                }
                Err(error) => eprintln!("watch error {error:?}"),
            }
        })?;

        debouncer
            .watcher()
            .watch(watch_path.as_ref(), RecursiveMode::Recursive)?;

        let (updates_sender, updates_receiver) = broadcast::channel(10);
        let (index_sender, mut index_receiver) = mpsc::channel::<oneshot::Sender<Index>>(10);

        spawn(async move {
            let _debouncer = debouncer;
            let mut images = collect_images(&watch_path).await.unwrap();
            loop {
                select! {
                    Some(sender) = index_receiver.recv() => {
                        sender.send(Index { images: images.clone() }).unwrap();
                    }
                    _ = notifier.notified() => {
                        let new_images = collect_images(&watch_path).await.unwrap();
                        let updates = detect_updates(&images, &new_images);
                        if !updates.additions.is_empty() || !updates.deletions.is_empty() {
                            updates_sender.send(updates).unwrap();
                        }
                        images = new_images;
                    }
                }
            }
        });
        Ok(Self {
            updates: updates_receiver,
            index: index_sender,
        })
    }

    pub async fn index(&self) -> Index {
        let (sender, receiver) = oneshot::channel();
        self.index.send(sender).await.unwrap();
        receiver.await.unwrap()
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Updates {
    pub additions: Vec<Image>,
    pub deletions: Vec<Image>,
}

fn detect_updates(old: &HashSet<Image>, new: &HashSet<Image>) -> Updates {
    let additions = new.difference(old).cloned().collect();
    let deletions = old.difference(new).cloned().collect();
    Updates {
        additions,
        deletions,
    }
}

async fn collect_images(storage_path: impl AsRef<Path>) -> Result<HashSet<Image>, IndexError> {
    println!("indexing {}", storage_path.as_ref().display());
    // TODO: walkdir is not async
    let walker = WalkDir::new(&storage_path).into_iter();
    let entries = walker
        .filter_entry(|entry| {
            entry.file_type().is_dir()
                || entry.file_type().is_file()
                    && entry
                        .path()
                        .extension()
                        .map(|extension| extension.to_ascii_lowercase())
                        .is_some_and(|extension| {
                            extension == "jpg"
                                || extension == "jpeg"
                                || extension == "png"
                                || extension == "heic"
                        })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut images = HashSet::with_capacity(entries.len());
    for entry in &entries {
        if entry.file_type().is_dir() {
            continue;
        }
        let path = entry.path();
        let metadata = metadata(path).await?;
        let modified = metadata.modified()?;

        images.insert(Image {
            path: path.strip_prefix(&storage_path).unwrap().to_path_buf(),
            modified,
        });
    }
    Ok(images)
}
